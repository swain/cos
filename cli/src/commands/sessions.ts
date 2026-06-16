import chalk from "chalk";
import { sessions as sessionsApi } from "../db.js";

// Any status outside this "live" set is terminal (completed/failed/killed/
// stale/archived, plus out-of-enum values like 'ended' that appear in prod).
// Re-flipping a terminal session to 'stale' is how the fleet "stale sessions"
// count got stuck on sess-01KPNS7RR2HE7RYA320KX44NPW on 2026-04-20 — the cron
// claude agent read the prompt "status != completed|failed|killed", found the
// manually-reaped status='ended' row, and called session-mark-stale on it.
const LIVE_SESSION_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "idle",
]);

export const cmdSessionMarkStale = (id: string) => {
  const s = sessionsApi.get(id);
  if (!s) {
    console.error(chalk.red(`session not found: ${id}`));
    process.exit(2);
  }
  if (!LIVE_SESSION_STATUSES.has(s.status)) {
    console.log(
      chalk.gray(`no-op: ${id} already in terminal status '${s.status}'`),
    );
    return;
  }
  sessionsApi.update(id, { status: "stale" });
  console.log(chalk.yellow("marked stale"), id);
};
