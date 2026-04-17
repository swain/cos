import { ulid } from "ulid";
import chalk from "chalk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { workItems, sessions, kv } from "../db.js";
import type { WorkItem, SessionKind } from "../types.js";
import {
  COS_DIR,
  PROMPTS_DIR,
  WORKLOGS_DIR,
  CONFIG_JSON,
  WATCHED_REPOS_JSON,
  slugify,
  parseJson,
} from "../util.js";

const HOME = homedir();

export const cmdSessionNew = (opts: {
  workItemId?: string;
  kind?: SessionKind;
  notes?: string;
}) => {
  const id = `sess-${ulid()}`;
  sessions.insert({
    id,
    work_item_id: opts.workItemId ?? null,
    tmux_window: null,
    kind: opts.kind ?? "worker",
    status: "starting",
    current_step: null,
    notes: opts.notes ?? null,
  });
  console.log(id);
  return id;
};

export const cmdWorkerDone = (
  sessionId: string,
  opts: { prUrl?: string; failed?: string },
) => {
  const s = sessions.get(sessionId);
  if (!s) {
    console.error(chalk.red(`session not found: ${sessionId}`));
    process.exit(2);
  }
  if (opts.prUrl) {
    sessions.update(sessionId, {
      status: "completed",
      current_step: "pr-opened",
      ended_at: new Date().toISOString(),
    });
    if (s.work_item_id) {
      const wi = workItems.get(s.work_item_id);
      if (wi) {
        const next = Array.from(new Set([...wi.pr_urls, opts.prUrl]));
        workItems.update(s.work_item_id, {
          status: "pr-open",
          pr_urls: next,
          session_id: null,
        });
      }
    }
    console.log(chalk.green("worker done"), sessionId, "→", opts.prUrl);
    return;
  }
  if (opts.failed) {
    sessions.update(sessionId, {
      status: "failed",
      current_step: "failed",
      notes: opts.failed,
      ended_at: new Date().toISOString(),
    });
    if (s.work_item_id)
      workItems.update(s.work_item_id, { status: "blocked", session_id: null });
    console.log(chalk.red("worker failed"), sessionId, "—", opts.failed);
    return;
  }
  console.error(chalk.red("worker-done requires --pr-url or --failed"));
  process.exit(2);
};

const findRepoLocalPath = (remoteName: string): string | null => {
  const reposBase = join(HOME, "Repos");
  const shortName = remoteName.includes("/")
    ? remoteName.split("/").pop()!
    : remoteName;
  // Check common locations
  const candidates = [
    join(reposBase, shortName),
    join(HOME, "Repos/thegoodparty", shortName),
  ];
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c;
  return null;
};

const postSetupHook = (repoShort: string): string => {
  const tsRepos = [
    "gp-api",
    "gp-webapp",
    "people-api",
    "election-api",
    "ops",
    "serve-ops",
  ];
  if (tsRepos.includes(repoShort)) return "npm install --legacy-peer-deps";
  if (repoShort === "gp-ai-projects") return "uv sync";
  return ":";
};

export const cmdWorkerSetup = (workItemId: string) => {
  const wi = workItems.get(workItemId);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemId}`));
    process.exit(2);
  }
  const cfg = parseJson<{ default_base_branch?: string }>(
    readFileSync(WATCHED_REPOS_JSON, "utf8"),
    {},
  );
  const baseBranch = cfg.default_base_branch ?? "develop";
  const slug = slugify(wi.title);
  const branch = `cos/${wi.id}-${slug}`;
  const out: Record<string, string> = {};

  for (const repoRaw of wi.repos) {
    if (repoRaw === "cos") {
      // Special case: COS itself. Worktree is just COS_DIR/cli for worker access.
      out["cos"] = COS_DIR;
      continue;
    }
    const short = repoRaw.includes("/") ? repoRaw.split("/").pop()! : repoRaw;
    const repoPath = findRepoLocalPath(repoRaw);
    if (!repoPath) {
      console.error(
        chalk.yellow(
          `repo not found locally: ${repoRaw} (skipping worktree, worker will handle)`,
        ),
      );
      continue;
    }
    const wtBase = join(dirname(repoPath), `${short}-worktrees`);
    mkdirSync(wtBase, { recursive: true });
    const wtPath = join(wtBase, `${wi.id}-${slug}`);
    if (!existsSync(wtPath)) {
      try {
        execSync(`git -C "${repoPath}" fetch origin ${baseBranch}`, {
          stdio: "pipe",
        });
        execSync(
          `git -C "${repoPath}" worktree add "${wtPath}" -b "${branch}" origin/${baseBranch}`,
          { stdio: "pipe" },
        );
      } catch (e: any) {
        console.error(
          chalk.yellow(`worktree create failed for ${short}: ${e.message}`),
        );
      }
      const hook = postSetupHook(short);
      if (hook !== ":") {
        try {
          execSync(hook, { cwd: wtPath, stdio: "inherit" });
        } catch (e: any) {
          console.error(
            chalk.yellow(`post-setup hook failed for ${short}: ${e.message}`),
          );
        }
      }
    }
    out[repoRaw] = wtPath;
  }
  workItems.update(workItemId, { worktree_paths: out });
  console.log(JSON.stringify(out, null, 2));
};

const workerPromptTemplate = () => {
  const p = join(PROMPTS_DIR, "worker.md");
  return existsSync(p) ? readFileSync(p, "utf8") : FALLBACK_WORKER_PROMPT;
};

const FALLBACK_WORKER_PROMPT = `You are a COS worker running on work item {{WI_ID}} (session {{SESSION_ID}}).

Goal:
{{TITLE}}

{{DESCRIPTION}}

Acceptance criteria:
{{ACCEPTANCE}}

Worktrees (work in these directories):
{{WORKTREES}}

Rules:
1. Before changing any repo, read its CLAUDE.md (and ~/.claude/cos/arch.md).
2. Create a branch off latest develop named \`cos/{{WI_ID}}-<slug>\`. Worktree command already created the branch.
3. Commit incrementally (one logical unit per commit, imperative subject lines).
4. Run tests + lint before opening any PR.
5. Do NOT self-approve. Open the PR with base=develop via \`gh pr create --base develop\`.
6. Sequential gating: do not open a second PR on this work item until the first merges.
7. Heartbeat at key transitions: \`~/.claude/cos/bin/cos heartbeat {{SESSION_ID}} --step <name>\`. Steps: started, branch-ready, tests-pass, pr-opened.
8. When PR is open, run: \`~/.claude/cos/bin/cos worker-done {{SESSION_ID}} --pr-url <url>\` and exit.
9. If stuck >10 min on any step, run \`~/.claude/cos/bin/cos worker-done {{SESSION_ID}} --failed "<reason>"\` and exit.
10. Write progress to the worklog at {{WORKLOG_PATH}} (goal, current step, notes).

Work item details (JSON):
{{WI_JSON}}

Begin now.`;

export const cmdWorkerPrompt = (workItemId: string, sessionId: string) => {
  const wi = workItems.get(workItemId);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemId}`));
    process.exit(2);
  }
  const worklogPath = wi.worklog_path ?? join(WORKLOGS_DIR, `${workItemId}.md`);
  if (!existsSync(worklogPath)) {
    writeFileSync(
      worklogPath,
      `# Worklog: ${wi.title}\n\n- work item: ${wi.id}\n- session: ${sessionId}\n- repos: ${wi.repos.join(", ")}\n- priority: P${wi.priority}\n\n## Goal\n${wi.description}\n\n## Acceptance\n${wi.acceptance_criteria}\n\n## Progress\n- started ${new Date().toISOString()}\n`,
    );
    workItems.update(workItemId, { worklog_path: worklogPath });
  }
  const worktrees =
    Object.entries(wi.worktree_paths)
      .map(([r, p]) => `- ${r}: ${p}`)
      .join("\n") || "(none configured)";
  const template = workerPromptTemplate();
  const filled = template
    .replaceAll("{{WI_ID}}", wi.id)
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("{{TITLE}}", wi.title)
    .replaceAll("{{DESCRIPTION}}", wi.description)
    .replaceAll("{{ACCEPTANCE}}", wi.acceptance_criteria)
    .replaceAll("{{WORKTREES}}", worktrees)
    .replaceAll("{{WORKLOG_PATH}}", worklogPath)
    .replaceAll("{{WI_JSON}}", JSON.stringify(wi, null, 2));
  process.stdout.write(filled);
};

export const cmdDispatch = (
  workItemId: string,
  opts: { force?: boolean } = {},
) => {
  const wi = workItems.get(workItemId);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemId}`));
    process.exit(2);
  }
  const cfg = parseJson<{
    dispatch_paused?: boolean;
    daily_worker_cap?: number;
    auto_dispatch_max_priority?: number;
  }>(readFileSync(CONFIG_JSON, "utf8"), {});
  if (cfg.dispatch_paused && !opts.force) {
    console.error(
      chalk.yellow(
        "dispatch is paused (config.json: dispatch_paused=true). Use --force to override.",
      ),
    );
    process.exit(3);
  }
  if (!opts.force) {
    if (wi.priority > (cfg.auto_dispatch_max_priority ?? 3)) {
      console.error(
        chalk.yellow(
          `priority ${wi.priority} exceeds auto_dispatch_max_priority. Use --force to override.`,
        ),
      );
      process.exit(3);
    }
    if (!wi.repos.length) {
      console.error(
        chalk.yellow("no repos set; refusing to dispatch without --force"),
      );
      process.exit(3);
    }
    if (!wi.acceptance_criteria.trim()) {
      console.error(
        chalk.yellow(
          "acceptance_criteria empty; refusing to dispatch without --force",
        ),
      );
      process.exit(3);
    }
    // Check existing sessions on this work item
    const existing = [
      ...sessions.list({ status: "running" }),
      ...sessions.list({ status: "starting" }),
    ].filter((s) => s.work_item_id === workItemId);
    if (existing.length) {
      console.error(
        chalk.yellow(`work item already has active session: ${existing[0].id}`),
      );
      process.exit(3);
    }
  }
  const spawnScript = join(COS_DIR, "bin/spawn-worker");
  if (!existsSync(spawnScript)) {
    console.error(chalk.red(`spawn-worker script not found: ${spawnScript}`));
    process.exit(2);
  }
  const res = spawnSync("bash", [spawnScript, workItemId], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(chalk.red(`spawn-worker exited with ${res.status}`));
    process.exit(res.status ?? 1);
  }
};

export const cmdWorkerPrimaryWorktree = (workItemId: string) => {
  const wi = workItems.get(workItemId);
  if (!wi) process.exit(2);
  const first = Object.values(wi.worktree_paths)[0];
  process.stdout.write(first ?? HOME);
};
