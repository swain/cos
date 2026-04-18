import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE_BIN, CLAUDE_PLUGIN_DIR, PROMPTS_DIR } from "../util.js";

export type CalendarCollectorResult = {
  ran: boolean;
  exitCode: number | null;
  reason?: string;
};

const findPromptPath = (): string => {
  const installed = join(PROMPTS_DIR, "calendar-collect.md");
  if (existsSync(installed)) return installed;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "../../../prompts/calendar-collect.md"),
    join(here, "../../prompts/calendar-collect.md"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return installed;
};

export const runCalendarCollector = (
  opts: { timeoutMs?: number } = {},
): CalendarCollectorResult => {
  const promptPath = findPromptPath();
  if (!existsSync(promptPath)) {
    return {
      ran: false,
      exitCode: null,
      reason: `calendar-collect.md prompt not found (looked at ${promptPath})`,
    };
  }
  if (!existsSync(CLAUDE_BIN)) {
    return {
      ran: false,
      exitCode: null,
      reason: `claude binary missing at ${CLAUDE_BIN}`,
    };
  }
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
    timeout: opts.timeoutMs ?? 180_000,
    killSignal: "SIGTERM",
  });
  if (res.error && (res.error as any).code === "ETIMEDOUT") {
    return {
      ran: true,
      exitCode: null,
      reason: `calendar collector timed out after ${opts.timeoutMs ?? 180_000}ms`,
    };
  }
  return { ran: true, exitCode: res.status };
};
