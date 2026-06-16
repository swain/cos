import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_BIN,
  CLAUDE_PLUGIN_DIR,
  PROMPTS_DIR,
  BRIEFS_DIR,
} from "../util.js";

export type BriefCollectorResult = {
  ran: boolean;
  exitCode: number | null;
  reason?: string;
};

const findPromptPath = (): string => {
  const installed = join(PROMPTS_DIR, "morning-brief.md");
  if (existsSync(installed)) return installed;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../prompts/morning-brief.md"),
    join(here, "../../prompts/morning-brief.md"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return installed;
};

export const runBriefCollector = (
  opts: { timeoutMs?: number } = {},
): BriefCollectorResult => {
  const promptPath = findPromptPath();
  if (!existsSync(promptPath)) {
    return {
      ran: false,
      exitCode: null,
      reason: `morning-brief.md not found (${promptPath})`,
    };
  }
  if (!existsSync(CLAUDE_BIN)) {
    return {
      ran: false,
      exitCode: null,
      reason: `claude binary missing at ${CLAUDE_BIN}`,
    };
  }
  mkdirSync(BRIEFS_DIR, { recursive: true });
  const prompt = readFileSync(promptPath, "utf8");
  const args = [
    "--plugin-dir",
    CLAUDE_PLUGIN_DIR,
    "--dangerously-skip-permissions",
    "-p",
    prompt,
  ];
  const res = spawnSync(CLAUDE_BIN, args, {
    stdio: "inherit",
    env: process.env,
    timeout: opts.timeoutMs ?? 420_000,
    killSignal: "SIGTERM",
  });
  if (res.error && (res.error as any).code === "ETIMEDOUT") {
    return {
      ran: true,
      exitCode: null,
      reason: `brief timed out after ${opts.timeoutMs ?? 420_000}ms`,
    };
  }
  return { ran: true, exitCode: res.status };
};
