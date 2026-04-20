import { ulid } from "ulid";
import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { notifications } from "../db.js";
import type { Urgency } from "../types.js";

export const cmdNotify = (opts: {
  subject: string;
  body?: string;
  urgency?: Urgency;
  related?: string[];
}) => {
  const id = `notif-${ulid()}`;
  notifications.insert({
    id,
    subject: opts.subject,
    body: opts.body ?? "",
    urgency: opts.urgency ?? "normal",
    related_ids: opts.related ?? [],
    pushed_at: null,
  });
  console.log(
    chalk.green("notification"),
    id,
    chalk.gray(opts.urgency ?? "normal"),
  );
  return id;
};

export const cmdNotifyListUnpushed = () => {
  const list = notifications.listUnpushed();
  if (!list.length) {
    console.log(chalk.gray("no unpushed notifications"));
    return;
  }
  for (const n of list) {
    console.log(`${n.id}  [${n.urgency}]  ${n.subject}`);
  }
};

export const cmdNotifyMarkPushed = (id: string) => {
  notifications.markPushed(id);
  console.log(chalk.gray("marked pushed"), id);
};

// Escape a string for safe interpolation inside an AppleScript double-quoted
// string literal. Backslashes and double quotes are the only two characters
// with special meaning inside an AS string; everything else (including
// newlines) passes through fine when handed to osascript via -e.
const escapeAppleScriptString = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

export const buildAppleScript = (
  subject: string,
  body: string,
  urgency: Urgency,
): string => {
  const subj = escapeAppleScriptString(subject);
  const bod = escapeAppleScriptString(body);
  const sound = urgency === "urgent" ? "Submarine" : null;
  const base = `display notification "${bod}" with title "${subj}"`;
  return sound ? `${base} sound name "${sound}"` : base;
};

export const cmdNotifyPush = (id: string, opts: { dryRun?: boolean } = {}) => {
  const n = notifications.get(id);
  if (!n) {
    console.error(chalk.red("notification not found:"), id);
    process.exit(1);
  }
  if (n.pushed_at) {
    console.log(chalk.gray("already pushed"), id, `at ${n.pushed_at}`);
    return;
  }

  const script = buildAppleScript(n.subject, n.body, n.urgency);

  if (opts.dryRun) {
    console.log(chalk.gray("[dry-run] osascript -e"), JSON.stringify(script));
    return;
  }

  if (process.platform !== "darwin") {
    console.warn(
      chalk.yellow("notify-push: osascript not supported on"),
      process.platform,
      chalk.gray("(no-op)"),
    );
    return;
  }

  try {
    execFileSync("osascript", ["-e", script], { stdio: "pipe" });
  } catch (e: any) {
    const stderr = e.stderr?.toString?.() ?? "";
    console.error(
      chalk.red("notify-push failed:"),
      e.message,
      stderr && `\n${stderr}`,
    );
    process.exit(1);
  }

  notifications.markPushed(id);
  console.log(chalk.green("pushed"), id);
};
