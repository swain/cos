import { ulid } from "ulid";
import chalk from "chalk";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { workItems } from "../db.js";
import { CLAUDE_BIN, CLAUDE_PLUGIN_DIR, HOME, PROMPTS_DIR } from "../util.js";
import { cmdEnqueue } from "./enqueue.js";

const ChunkSchema = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "key must be kebab-case"),
  title: z.string().min(1).max(120),
  description: z.string().min(1),
  acceptance_criteria: z.string().min(1),
  repos: z.array(z.string()).min(1),
  priority: z.number().int().min(1).max(5),
  depends_on_keys: z.array(z.string()).default([]),
});
export type Chunk = z.infer<typeof ChunkSchema>;

const PlanSchema = z.object({
  chunks: z.array(ChunkSchema).min(1),
  notes: z.string().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/gi;

export const extractPlanJson = (stdout: string): string => {
  const matches = [...stdout.matchAll(JSON_BLOCK_RE)];
  if (matches.length) return matches[matches.length - 1][1].trim();
  // Fallback: no fenced block — try to find a top-level JSON object.
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return stdout.slice(firstBrace, lastBrace + 1).trim();
  }
  throw new Error("no JSON block found in planner output");
};

export const validatePlan = (
  plan: Plan,
  parentRepos: string[],
): { errors: string[] } => {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const c of plan.chunks) {
    if (keys.has(c.key)) errors.push(`duplicate chunk key: ${c.key}`);
    keys.add(c.key);
  }
  for (const c of plan.chunks) {
    for (const dep of c.depends_on_keys) {
      if (dep === c.key) errors.push(`chunk ${c.key} depends on itself`);
      if (!keys.has(dep))
        errors.push(`chunk ${c.key} depends on unknown key: ${dep}`);
    }
    const parentSet = new Set(parentRepos);
    for (const r of c.repos) {
      if (!parentSet.has(r)) {
        errors.push(
          `chunk ${c.key} repo '${r}' not in parent repos [${parentRepos.join(", ")}]`,
        );
      }
    }
  }
  // Cycle detection via DFS on the key graph.
  const adj = new Map<string, string[]>();
  for (const c of plan.chunks) adj.set(c.key, c.depends_on_keys);
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  for (const k of keys) color.set(k, WHITE);
  const visit = (k: string, path: string[]): boolean => {
    color.set(k, GRAY);
    for (const next of adj.get(k) ?? []) {
      const c = color.get(next);
      if (c === GRAY) {
        errors.push(`cycle detected: ${[...path, k, next].join(" → ")}`);
        return false;
      }
      if (c === WHITE && !visit(next, [...path, k])) return false;
    }
    color.set(k, BLACK);
    return true;
  };
  for (const k of keys) if (color.get(k) === WHITE) visit(k, []);
  return { errors };
};

const buildPrompt = (
  parent: ReturnType<typeof workItems.get>,
  parentJson: string,
  claudeMdPaths: string[],
): string => {
  const promptPath = join(PROMPTS_DIR, "planner.md");
  const template = existsSync(promptPath)
    ? readFileSync(promptPath, "utf8")
    : FALLBACK_PROMPT;
  return template
    .replaceAll("{{PARENT_JSON}}", parentJson)
    .replaceAll(
      "{{CLAUDE_MD_PATHS}}",
      claudeMdPaths.length
        ? claudeMdPaths.map((p) => `- ${p}`).join("\n")
        : "(no repo CLAUDE.md paths known — read what you need ad hoc)",
    )
    .replaceAll("{{STATE_SNAPSHOT}}", JSON.stringify({ parent }, null, 2));
};

const FALLBACK_PROMPT = `You are the COS planning subagent. Decompose the parent work item below into PR-sized chunks with an explicit dependency graph. Output a single fenced JSON block with shape {"chunks":[{"key","title","description","acceptance_criteria","repos","priority","depends_on_keys"}],"notes?"} and nothing else after your reasoning.

Parent:
{{PARENT_JSON}}

CLAUDE.md paths:
{{CLAUDE_MD_PATHS}}
`;

const locateClaudeMds = (repos: string[]): string[] => {
  const out: string[] = [];
  const candidates = [join(HOME, "Repos"), join(HOME, "Repos/thegoodparty")];
  for (const repo of repos) {
    for (const base of candidates) {
      const p = join(base, repo, "CLAUDE.md");
      if (existsSync(p)) {
        out.push(p);
        break;
      }
    }
  }
  return out;
};

export type PlanOptions = {
  dryRun?: boolean;
  replan?: boolean;
  fromFile?: string;
};

export const cmdPlan = (workItemRef: string, opts: PlanOptions = {}) => {
  const parent = workItems.resolve(workItemRef);
  if (!parent) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  const workItemId = parent.id;
  const existingChildren = workItems.listChildren(workItemId);
  if (existingChildren.length && !opts.replan) {
    console.error(
      chalk.yellow(
        `${workItemId} already has ${existingChildren.length} child chunk(s); use --replan to override (not yet supported).`,
      ),
    );
    process.exit(3);
  }

  const claudeMdPaths = locateClaudeMds(parent.repos);
  const parentJson = JSON.stringify(parent, null, 2);

  let planJsonText: string;
  if (opts.fromFile) {
    if (!existsSync(opts.fromFile)) {
      console.error(chalk.red(`--from-file not found: ${opts.fromFile}`));
      process.exit(2);
    }
    planJsonText = readFileSync(opts.fromFile, "utf8");
  } else {
    const prompt = buildPrompt(parent, parentJson, claudeMdPaths);
    if (opts.dryRun) {
      process.stdout.write(prompt);
      return;
    }
    console.error(
      chalk.gray(
        `[plan] invoking claude planning subagent for ${workItemId} (${parent.repos.join(",")})`,
      ),
    );
    const res = spawnSync(
      CLAUDE_BIN,
      [
        "--plugin-dir",
        CLAUDE_PLUGIN_DIR,
        "--dangerously-skip-permissions",
        "-p",
        prompt,
      ],
      {
        stdio: ["ignore", "pipe", "inherit"],
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    if (res.status !== 0) {
      console.error(chalk.red(`claude exited ${res.status}`));
      process.exit(res.status ?? 1);
    }
    try {
      planJsonText = extractPlanJson(String(res.stdout));
    } catch (e: any) {
      console.error(chalk.red(`plan parse error: ${e.message}`));
      console.error(chalk.gray("claude stdout:"));
      console.error(String(res.stdout));
      process.exit(4);
    }
  }

  let plan: Plan;
  try {
    const raw = JSON.parse(planJsonText);
    plan = PlanSchema.parse(raw);
  } catch (e: any) {
    console.error(chalk.red(`plan validation error: ${e.message}`));
    console.error(chalk.gray(planJsonText.slice(0, 2000)));
    process.exit(4);
  }
  const { errors } = validatePlan(plan, parent.repos);
  if (errors.length) {
    console.error(chalk.red(`plan graph invalid:`));
    for (const err of errors) console.error(chalk.red(`  - ${err}`));
    process.exit(4);
  }

  // Create child work items first (no deps), then wire deps using the
  // key → wi-id mapping. Dispatching the parent stays blocked because we
  // set parent.depends_on to all child ids and parent.needs_planning=0.
  const keyToId = new Map<string, string>();
  for (const c of plan.chunks) {
    const childId = cmdEnqueue({
      title: c.title,
      description: c.description,
      acceptance: c.acceptance_criteria,
      repos: c.repos,
      priority: c.priority,
      source: `plan:${workItemId}`,
      parentId: workItemId,
      dependsOn: [],
      needsPlanning: false,
    });
    keyToId.set(c.key, childId);
  }
  for (const c of plan.chunks) {
    if (!c.depends_on_keys.length) continue;
    const childId = keyToId.get(c.key)!;
    const depIds = c.depends_on_keys.map((k) => keyToId.get(k)!);
    workItems.update(childId, { depends_on: depIds });
  }

  const childIds = Array.from(keyToId.values());
  workItems.update(workItemId, {
    needs_planning: false,
    depends_on: childIds,
  });

  console.log(
    chalk.green("planned"),
    workItemId,
    chalk.gray(`→ ${plan.chunks.length} chunk(s)`),
  );
  for (const c of plan.chunks) {
    const id = keyToId.get(c.key)!;
    const depLabels = c.depends_on_keys.length
      ? ` deps=[${c.depends_on_keys.join(",")}]`
      : "";
    console.log(
      chalk.cyan(`  ${c.key}`),
      id,
      chalk.gray(`${c.repos.join(",")} P${c.priority}${depLabels}`),
    );
  }
  if (plan.notes) console.log(chalk.gray(`\nnotes: ${plan.notes}`));
};
