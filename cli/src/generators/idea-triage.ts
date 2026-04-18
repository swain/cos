import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import chalk from "chalk";
import { ideas, workItems } from "../db.js";
import {
  CLAUDE_BIN,
  CLAUDE_PLUGIN_DIR,
  COS_DIR,
  PRIORITIES_MD,
} from "../util.js";
import { join } from "node:path";
import type { Idea, WorkItem } from "../types.js";

const ARCH_MD = join(COS_DIR, "arch.md");

const TriageResultSchema = z.object({
  id: z.string(),
  verdict: z.enum(["suggest-promote", "suggest-kill", "your-call"]),
  rationale: z.string().min(1).max(400),
  score: z.number().min(0).max(1),
});
export type TriageResult = z.infer<typeof TriageResultSchema>;

const TriageResponseSchema = z.object({
  results: z.array(TriageResultSchema),
});

const JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/gi;

export const extractTriageJson = (stdout: string): string => {
  const matches = [...stdout.matchAll(JSON_BLOCK_RE)];
  if (matches.length) return matches[matches.length - 1][1].trim();
  const firstBrace = stdout.indexOf("{");
  const lastBrace = stdout.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return stdout.slice(firstBrace, lastBrace + 1).trim();
  }
  throw new Error("no JSON block found in triage output");
};

const readFileOrEmpty = (path: string): string =>
  existsSync(path) ? readFileSync(path, "utf8") : "";

const buildPrompt = (batch: Idea[], queue: WorkItem[]): string => {
  const priorities = readFileOrEmpty(PRIORITIES_MD);
  const arch = readFileOrEmpty(ARCH_MD);
  const queueLines = queue.length
    ? queue
        .map((wi) => `- P${wi.priority} ${wi.title} [${wi.repos.join(",")}]`)
        .join("\n")
    : "(queue is empty)";
  const ideaJson = JSON.stringify(
    batch.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description,
      source: i.source,
      confidence: i.confidence,
      repos_guess: i.repos_guess,
    })),
    null,
    2,
  );
  return `You are the COS idea-triage subagent. Score a batch of raw ideas against the user's current priorities, the platform architecture, and what's already queued — so the user's inbox surfaces a pre-triaged slice instead of a dump.

For each idea, output exactly one of:
- "suggest-promote" — this is a clear win given priorities; the user should click through and queue it.
- "suggest-kill" — this is low-value, out-of-scope, stale, or duplicative; the user should kill it.
- "your-call" — reasonable but requires the user's judgment (strategic tradeoff, scope ambiguity, unclear ROI).

Ground rules:
- When in doubt between promote and kill, choose "your-call". The cost of a bad auto-action is higher than the cost of surfacing an extra decision.
- Velocity bias: the user runs a pre-PMF pod. Over-elegance and premature abstraction are losses. Cheap, high-ROI moves beat sweeping refactors.
- If the idea duplicates something already queued, prefer "suggest-kill".
- "rationale" must be one sentence, max ~160 chars, plain English. No hedging, no markdown.
- "score" is a confidence in your verdict, 0-1. Use higher values (0.8+) only when the call is obvious.

Output a single fenced \`\`\`json block with shape:
{ "results": [ { "id": "<idea-id>", "verdict": "...", "rationale": "...", "score": 0.0 } ] }

Include exactly one result per input idea. No extra keys, no prose after the block.

## Priorities

${priorities || "(priorities.md not found)"}

## Architecture

${arch || "(arch.md not found)"}

## Currently queued work

${queueLines}

## Ideas to triage

\`\`\`json
${ideaJson}
\`\`\`
`;
};

export type TriageOptions = {
  limit?: number;
  fromFile?: string;
  dryRun?: boolean;
  timeoutMs?: number;
};

export type TriageRunResult = {
  attempted: number;
  triaged: number;
  skipped: number;
  errorMessage?: string;
};

const DEFAULT_LIMIT = 25;
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

export const runIdeaTriage = (opts: TriageOptions = {}): TriageRunResult => {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const batch = ideas.listUntriaged(limit);
  if (!batch.length) {
    return { attempted: 0, triaged: 0, skipped: 0 };
  }
  const queue = workItems.list({ status: "queued" });
  const prompt = buildPrompt(batch, queue);

  if (opts.dryRun && !opts.fromFile) {
    process.stdout.write(prompt);
    return { attempted: batch.length, triaged: 0, skipped: batch.length };
  }

  let jsonText: string;
  if (opts.fromFile) {
    if (!existsSync(opts.fromFile)) {
      return {
        attempted: batch.length,
        triaged: 0,
        skipped: batch.length,
        errorMessage: `--from-file not found: ${opts.fromFile}`,
      };
    }
    jsonText = readFileSync(opts.fromFile, "utf8");
  } else {
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
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
    );
    if (res.status !== 0) {
      return {
        attempted: batch.length,
        triaged: 0,
        skipped: batch.length,
        errorMessage: `claude exited ${res.status}: ${String(res.stderr).slice(0, 400)}`,
      };
    }
    try {
      jsonText = extractTriageJson(String(res.stdout));
    } catch (e: any) {
      return {
        attempted: batch.length,
        triaged: 0,
        skipped: batch.length,
        errorMessage: `parse error: ${e.message}`,
      };
    }
  }

  let parsed: { results: TriageResult[] };
  try {
    parsed = TriageResponseSchema.parse(JSON.parse(jsonText));
  } catch (e: any) {
    return {
      attempted: batch.length,
      triaged: 0,
      skipped: batch.length,
      errorMessage: `validation error: ${e.message}`,
    };
  }

  const byId = new Map(parsed.results.map((r) => [r.id, r]));
  let triaged = 0;
  let skipped = 0;
  for (const idea of batch) {
    const r = byId.get(idea.id);
    if (!r) {
      skipped++;
      continue;
    }
    ideas.updateTriage(idea.id, {
      verdict: r.verdict,
      rationale: r.rationale,
      score: r.score,
    });
    triaged++;
  }
  return { attempted: batch.length, triaged, skipped };
};

export const cmdIdeaTriage = (opts: {
  limit?: number;
  fromFile?: string;
  dryRun?: boolean;
}) => {
  const res = runIdeaTriage(opts);
  if (res.errorMessage) {
    console.error(chalk.red(`triage error: ${res.errorMessage}`));
    process.exit(1);
  }
  if (!res.attempted) {
    console.log(chalk.gray("no untriaged ideas"));
    return;
  }
  if (opts.dryRun && !opts.fromFile) {
    return;
  }
  console.log(
    chalk.green(`triaged ${res.triaged}/${res.attempted}`),
    res.skipped ? chalk.yellow(`skipped=${res.skipped}`) : "",
  );
};
