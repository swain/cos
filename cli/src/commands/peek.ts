import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { sessions, workItems } from "../db.js";
import { LOGS_DIR } from "../util.js";
import type { Session } from "../types.js";

const TMUX_SESSION = "cos-workers";
const TITLE_WIDTH = 40;
const STEP_WIDTH = 14;
const SESS_TAIL_LEN = 6;
const TAIL_LINES_DEFAULT = 35;

type PeekOpts = {
  attach?: boolean;
  list?: boolean;
  lines?: number;
};

const ensureTmux = () => {
  const which = spawnSync("which", ["tmux"], { stdio: "ignore" });
  if (which.status !== 0) {
    console.error(
      chalk.red("tmux is not installed."),
      "Install it (e.g. `brew install tmux`) and try again.",
    );
    process.exit(2);
  }
};

const tmuxAttachOrList = (list: boolean) => {
  ensureTmux();
  const has = spawnSync("tmux", ["has-session", "-t", TMUX_SESSION], {
    stdio: "ignore",
  });
  if (has.status !== 0) {
    console.log(
      chalk.gray(
        `No workers running (tmux session "${TMUX_SESSION}" not found).`,
      ),
    );
    console.log(chalk.gray("Run `cos peek` for a summary, or `cos fleet`."));
    process.exit(0);
  }
  const args = list
    ? ["list-windows", "-t", TMUX_SESSION]
    : ["attach-session", "-t", TMUX_SESSION];
  const child = spawnSync("tmux", args, { stdio: "inherit" });
  process.exit(child.status ?? 1);
};

const sessTail = (id: string): string => {
  const s = id.replace(/^sess-/, "");
  return s.length <= SESS_TAIL_LEN ? s : s.slice(-SESS_TAIL_LEN);
};

const wiTail = (id: string): string => {
  const s = id.replace(/^wi-/, "");
  return s.length <= SESS_TAIL_LEN ? s : s.slice(-SESS_TAIL_LEN);
};

const padRight = (s: string, n: number): string =>
  s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length);

const trim = (s: string, n: number): string =>
  s.length <= n ? s : s.slice(0, n - 1) + "…";

// "minutes since ts" — ts is ISO-ish ("YYYY-MM-DD HH:MM:SS" UTC from sqlite).
const minutesSince = (ts: string | null): number | null => {
  if (!ts) return null;
  const normalized = ts.includes("T") ? ts : ts.replace(" ", "T") + "Z";
  const t = Date.parse(normalized);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
};

const lastLogLine = (sessionId: string): string => {
  const path = join(LOGS_DIR, `worker-${sessionId}.log`);
  if (!existsSync(path)) return "(no log)";
  try {
    const stat = statSync(path);
    if (stat.size === 0) return "(empty log)";
    const start = Math.max(0, stat.size - 8 * 1024);
    const buf = readFileSync(path);
    const tail = buf.subarray(start).toString("utf8");
    const lines = tail
      .split("\n")
      .map((l) => l.replace(/\r/g, "").trim())
      .filter(Boolean);
    return lines.length ? lines[lines.length - 1] : "(blank tail)";
  } catch {
    return "(log read err)";
  }
};

const titleFor = (workItemId: string | null): string => {
  if (!workItemId) return "—";
  return workItems.get(workItemId)?.title ?? "—";
};

const fmtHb = (m: number | null): string =>
  m === null ? "?" : m < 1 ? "<1m" : `${m}m`;

const renderSummary = () => {
  const running = sessions
    .list({ status: "running" })
    .filter((s) => s.kind === "worker");
  const starting = sessions
    .list({ status: "starting" })
    .filter((s) => s.kind === "worker");
  const idle = sessions
    .list({ status: "idle" })
    .filter((s) => s.kind === "worker");
  const stale = sessions
    .list({ status: "stale" })
    .filter((s) => s.kind === "worker");

  const all: Session[] = [...running, ...starting, ...idle, ...stale];
  const total = all.length;

  const headerParts = [
    `${running.length} running`,
    starting.length ? `${starting.length} starting` : null,
    `${idle.length} idle`,
    `${stale.length} stale`,
  ].filter(Boolean) as string[];

  const header = total
    ? `${total} worker${total === 1 ? "" : "s"}: ${headerParts.join(", ")}`
    : "0 workers";

  console.log(chalk.bold(header));

  if (!total) {
    console.log(
      chalk.gray("No active worker sessions. Run `cos fleet` for queue state."),
    );
    console.log(
      chalk.gray("Use `cos peek --attach` to attach the tmux session."),
    );
    return;
  }

  const cols = ["SESS", "WI TITLE", "STEP", "HB", "LAST"];
  const widths = [SESS_TAIL_LEN, TITLE_WIDTH, STEP_WIDTH, 5];
  const headerRow =
    padRight(cols[0], widths[0]) +
    "  " +
    padRight(cols[1], widths[1]) +
    "  " +
    padRight(cols[2], widths[2]) +
    "  " +
    padRight(cols[3], widths[3]) +
    "  " +
    cols[4];
  console.log(chalk.dim(headerRow));

  for (const s of all) {
    const sess = sessTail(s.id);
    const title = trim(titleFor(s.work_item_id), TITLE_WIDTH);
    const step = trim(s.current_step ?? "—", STEP_WIDTH);
    const hb = fmtHb(minutesSince(s.last_heartbeat));
    const last = trim(lastLogLine(s.id), 60);

    const colorize =
      s.status === "stale"
        ? chalk.red
        : s.status === "idle"
          ? chalk.yellow
          : (x: string) => x;

    console.log(
      colorize(
        padRight(sess, widths[0]) +
          "  " +
          padRight(title, widths[1]) +
          "  " +
          padRight(step, widths[2]) +
          "  " +
          padRight(hb, widths[3]) +
          "  " +
          last,
      ),
    );
  }
};

const tmuxWindows = (): { index: string; name: string }[] => {
  try {
    const out = execFileSync(
      "tmux",
      [
        "list-windows",
        "-t",
        TMUX_SESSION,
        "-F",
        "#{window_index} #{window_name}",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [index, ...rest] = l.split(/\s+/);
        return { index, name: rest.join(" ") };
      });
  } catch {
    return [];
  }
};

const expectedWindowName = (workItemId: string): string =>
  workItemId.replace(/^wi-/, "").slice(0, 18);

const sessionForWindowName = (windowName: string): Session | null => {
  const allWorkers = [
    ...sessions.list({ status: "running" }),
    ...sessions.list({ status: "starting" }),
    ...sessions.list({ status: "idle" }),
    ...sessions.list({ status: "stale" }),
  ].filter((s) => s.kind === "worker");
  return (
    allWorkers.find(
      (s) =>
        s.work_item_id && expectedWindowName(s.work_item_id) === windowName,
    ) ?? null
  );
};

const resolveTarget = (target: string): Session | null => {
  // 1. Pure-numeric → tmux window index.
  if (/^\d+$/.test(target)) {
    const wins = tmuxWindows();
    const win = wins.find((w) => w.index === target);
    if (win) {
      const s = sessionForWindowName(win.name);
      if (s) return s;
    }
  }

  // 2. Match against session ids and work-item ids — full id, prefix, or
  //    last-N-chars (the form printed by the summary table).
  const allWorkers = [
    ...sessions.list({ status: "running" }),
    ...sessions.list({ status: "starting" }),
    ...sessions.list({ status: "idle" }),
    ...sessions.list({ status: "stale" }),
    ...sessions.list({ status: "completed" }),
    ...sessions.list({ status: "failed" }),
    ...sessions.list({ status: "killed" }),
  ].filter((s) => s.kind === "worker");

  const hits = allWorkers.filter((s) => {
    if (s.id === target) return true;
    if (s.id.startsWith(target)) return true;
    if (sessTail(s.id) === target) return true;
    if (s.work_item_id) {
      if (s.work_item_id === target) return true;
      if (s.work_item_id.startsWith(target)) return true;
      if (`wi-${target}` === s.work_item_id) return true;
      if (wiTail(s.work_item_id) === target) return true;
    }
    return false;
  });

  if (hits.length === 0) return null;
  // Prefer the most recently started session if multiple match.
  hits.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return hits[0];
};

const showLogTail = (sessionId: string, lines: number) => {
  const path = join(LOGS_DIR, `worker-${sessionId}.log`);
  if (!existsSync(path)) {
    console.error(chalk.yellow(`No log file at ${path}`));
    process.exit(1);
  }
  const child = spawnSync("tail", ["-n", String(lines), path], {
    stdio: "inherit",
  });
  process.exit(child.status ?? 1);
};

export const cmdPeek = (target: string | undefined, opts: PeekOpts = {}) => {
  if (opts.attach || opts.list) {
    tmuxAttachOrList(!!opts.list);
    return;
  }

  if (!target) {
    renderSummary();
    return;
  }

  const session = resolveTarget(target);
  if (!session) {
    console.error(
      chalk.red(`No worker matches "${target}".`),
      "Try `cos peek` to list active workers.",
    );
    process.exit(1);
  }

  const lines = opts.lines ?? TAIL_LINES_DEFAULT;
  const wiTitle = titleFor(session.work_item_id);
  const path = join(LOGS_DIR, `worker-${session.id}.log`);
  console.log(
    chalk.dim(
      `# ${session.id} (${wiTitle})  status=${session.status} step=${session.current_step ?? "—"} hb=${session.last_heartbeat}`,
    ),
  );
  console.log(chalk.dim(`# ${path} (last ${lines} lines)`));
  console.log("");
  showLogTail(session.id, lines);
};
