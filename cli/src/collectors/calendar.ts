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

// Preamble injected before the prompt when the caller wants prep for a single
// named event rather than the default 20-30min window. Shipped with the prompt
// itself so the subprocess sees it as one contiguous instruction block.
const SINGLE_EVENT_PREAMBLE = (eventId: string) => `
SINGLE-EVENT OVERRIDE — read this before anything else.

You are being invoked to prepare exactly one event. Do NOT scan the next 2h window. Do NOT apply the 20–30 minute filter. Instead:

1. Fetch the event:
   /opt/homebrew/bin/gws calendar events get --params '{"calendarId":"primary","eventId":"${eventId}"}' --format json 2>/dev/null
   (Suppress stderr so the keyring line does not pollute JSON parsing. Use the absolute path — launchd's PATH does not include /opt/homebrew/bin.)
2. Run sections 3 (context gathering), 4 (write prep file), and 5 (signal + notification) of the instructions below, but ONLY for that one event. Skip sections 1 and 2 entirely.
3. If the event is in the past, cancelled, or has no other attendees, print \`no-prep-needed\` and exit.
4. If a prep file already exists for the event's date+slug, overwrite it — the ad-hoc Prep Now action is an explicit refresh request from the user.
5. If \`gws calendar events get\` exits non-zero, \`/opt/homebrew/bin/gws\` is missing, or the event doesn't exist, print \`gws-event-fetch-failed\` to stdout (not \`no-prep-needed\`) and exit. This distinguishes user-declined-to-prep from infrastructure-broken so the dashboard can render the two outcomes differently.

The rest of the prompt follows:

---

`;

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
  opts: { timeoutMs?: number; eventId?: string } = {},
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
  const basePrompt = readFileSync(promptPath, "utf8");
  const prompt = opts.eventId
    ? SINGLE_EVENT_PREAMBLE(opts.eventId) + basePrompt
    : basePrompt;
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
