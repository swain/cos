import { execFileSync } from "node:child_process";
import { CLAUDE_BIN, CLAUDE_PLUGIN_DIR, nowIso } from "../util.js";
import { kv } from "../db.js";

export type CollectedSignal = {
  source: "slack";
  kind: "slack-dm" | "slack-mention";
  external_id: string | null;
  payload: Record<string, unknown>;
};

const SINCE_KEY = "slack:last_collected_ts";
const DEFAULT_LOOKBACK_MS = 60 * 60 * 1000;
const CLAUDE_TIMEOUT_MS = 90_000;

// Privacy: the prompt explicitly forbids Claude from returning message text.
// If that instruction is ever violated we drop any `text`/`body` keys on
// receipt before inserting into fleet.db.
const buildPrompt = (
  sinceIso: string,
): string => `You are a data collector. Use ONLY the Slack MCP tools.

Goal: find, since ${sinceIso}:
(a) Direct messages (DMs) sent TO the authenticated user that are still unread.
(b) Messages in channels the authenticated user is a member of which @-mention that user.

Rules:
- Output strict JSON only. No prose, no markdown fences, no explanation.
- Do NOT include message text, body, or any snippet of the message content. Permalinks, author IDs, channel IDs, and timestamps ONLY. This is a privacy-preserving index.
- If the Slack MCP is unavailable or you cannot authenticate, output {"dms":[],"mentions":[]} and stop.
- Dedupe by permalink.

Output shape (exactly these keys, no others):
{
  "dms": [
    { "permalink": "https://<workspace>.slack.com/archives/...", "author": "<user id or name>", "channel": "<dm channel id>", "ts": "<slack ts>" }
  ],
  "mentions": [
    { "permalink": "https://<workspace>.slack.com/archives/...", "author": "<user id or name>", "channel": "<channel id>", "ts": "<slack ts>" }
  ]
}
`;

const sanitizeEntry = (
  e: Record<string, unknown>,
): {
  permalink: string;
  author: string | null;
  channel: string | null;
  ts: string | null;
} | null => {
  const permalink = typeof e.permalink === "string" ? e.permalink : null;
  if (!permalink) return null;
  return {
    permalink,
    author: typeof e.author === "string" ? e.author : null,
    channel: typeof e.channel === "string" ? e.channel : null,
    ts: typeof e.ts === "string" ? e.ts : null,
  };
};

const runClaudeCollector = (prompt: string): string | null => {
  try {
    return execFileSync(
      CLAUDE_BIN,
      [
        "--plugin-dir",
        CLAUDE_PLUGIN_DIR,
        "--dangerously-skip-permissions",
        "--output-format",
        "json",
        "-p",
        prompt,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 4 * 1024 * 1024,
        timeout: CLAUDE_TIMEOUT_MS,
      },
    );
  } catch (e: any) {
    console.error(
      `[slack] claude invocation failed: ${String(e.message).slice(0, 200)}`,
    );
    return null;
  }
};

const extractResult = (raw: string): string | null => {
  try {
    const parsed = JSON.parse(raw);
    const r = parsed?.result;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
};

const parseCollectorOutput = (
  text: string,
): { dms: any[]; mentions: any[] } | null => {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");
  try {
    const parsed = JSON.parse(stripped);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      dms: Array.isArray(parsed.dms) ? parsed.dms : [],
      mentions: Array.isArray(parsed.mentions) ? parsed.mentions : [],
    };
  } catch {
    return null;
  }
};

export const collectSlackSignals = async (): Promise<CollectedSignal[]> => {
  const since =
    kv.get(SINCE_KEY) ??
    new Date(Date.now() - DEFAULT_LOOKBACK_MS).toISOString();
  const startedAt = nowIso();

  const raw = runClaudeCollector(buildPrompt(since));
  if (!raw) return [];

  const result = extractResult(raw);
  if (!result) {
    console.error("[slack] collector returned no result field");
    return [];
  }

  const parsed = parseCollectorOutput(result);
  if (!parsed) {
    console.error(
      `[slack] could not parse collector output: ${result.slice(0, 200)}`,
    );
    return [];
  }

  const out: CollectedSignal[] = [];
  for (const raw of parsed.dms) {
    const e = sanitizeEntry(raw ?? {});
    if (!e) continue;
    out.push({
      source: "slack",
      kind: "slack-dm",
      external_id: e.permalink,
      payload: e,
    });
  }
  for (const raw of parsed.mentions) {
    const e = sanitizeEntry(raw ?? {});
    if (!e) continue;
    out.push({
      source: "slack",
      kind: "slack-mention",
      external_id: e.permalink,
      payload: e,
    });
  }

  kv.set(SINCE_KEY, startedAt);
  return out;
};
