import { ulid } from "ulid";
import chalk from "chalk";
import { signals, ideas, workItems, notifications } from "../db.js";
import { collectGithubSignals } from "../collectors/github.js";
import { runCalendarCollector } from "../collectors/calendar.js";
import { collectClickupSignals } from "../collectors/clickup.js";
import type { Signal } from "../types.js";

export const cmdSignalsList = (filter?: {
  status?: string;
  source?: string;
}) => {
  const list = signals.list(filter);
  if (!list.length) {
    console.log(chalk.gray("no signals"));
    return;
  }
  for (const s of list) {
    console.log(
      `${s.id}  ${s.source.padEnd(10)} ${s.kind.padEnd(24)} ${s.status.padEnd(22)} ${s.external_id ?? ""}`,
    );
  }
};

export type TriageAction = "suppress" | "idea" | "work-item" | "notify";

export const cmdSignalTriage = (
  signalId: string,
  action: TriageAction,
  opts: {
    title?: string;
    description?: string;
    priority?: number;
    repos?: string[];
    acceptance?: string;
    urgency?: "urgent" | "normal" | "digest";
    body?: string;
  } = {},
) => {
  const s = signals.get(signalId);
  if (!s) {
    console.error(chalk.red(`signal not found: ${signalId}`));
    process.exit(2);
  }
  if (action === "suppress") {
    signals.update(signalId, {
      status: "suppressed",
      triaged_at: new Date().toISOString(),
    });
    console.log(chalk.gray("suppressed"), signalId);
    return;
  }
  if (action === "idea") {
    const id = `idea-${ulid()}`;
    ideas.insert({
      id,
      title: opts.title ?? `${s.kind} from ${s.source}`,
      description: opts.description ?? JSON.stringify(s.payload, null, 2),
      source: `cos-triage:${signalId}`,
      confidence: 0.5,
      repos_guess: opts.repos ?? [],
      status: "new",
      promoted_to: null,
    });
    signals.update(signalId, {
      status: "converted-to-idea",
      triaged_at: new Date().toISOString(),
    });
    console.log(chalk.green("→ idea"), id);
    return;
  }
  if (action === "work-item") {
    const wiId = `wi-${ulid()}`;
    workItems.insert({
      id: wiId,
      title: opts.title ?? `${s.kind}: ${s.external_id ?? s.id}`,
      description: opts.description ?? JSON.stringify(s.payload, null, 2),
      acceptance_criteria: opts.acceptance ?? "",
      repos: opts.repos ?? [],
      priority: opts.priority ?? 3,
      status: "queued",
      source: `signal:${signalId}`,
      depends_on: [],
      session_id: null,
      pr_urls: [],
      worklog_path: null,
      worktree_paths: {},
      needs_approval: false,
    });
    signals.update(signalId, {
      status: "converted-to-work-item",
      triaged_at: new Date().toISOString(),
    });
    console.log(chalk.green("→ work item"), wiId);
    return;
  }
  if (action === "notify") {
    const nId = `notif-${ulid()}`;
    notifications.insert({
      id: nId,
      subject: opts.title ?? `${s.kind} from ${s.source}`,
      body: opts.body ?? JSON.stringify(s.payload, null, 2),
      urgency: opts.urgency ?? "normal",
      related_ids: [signalId],
      pushed_at: null,
    });
    signals.update(signalId, {
      status: "triaged",
      triaged_at: new Date().toISOString(),
    });
    console.log(chalk.green("→ notification"), nId);
    return;
  }
  console.error(chalk.red(`unknown action: ${action}`));
  process.exit(2);
};

export const cmdSignalAdd = (opts: {
  source: string;
  kind: string;
  externalId?: string;
  payload?: Record<string, unknown>;
}) => {
  const id = `sig-${ulid()}`;
  const res = signals.insert({
    id,
    source: opts.source,
    kind: opts.kind,
    external_id: opts.externalId ?? null,
    payload: opts.payload ?? {},
    status: "new",
    triaged_at: null,
  });
  if (res.inserted) {
    console.log(chalk.green("signal"), id);
  } else {
    console.log(
      chalk.gray("signal duplicate"),
      `(source=${opts.source} kind=${opts.kind} external_id=${opts.externalId})`,
    );
  }
  return res;
};

export const cmdCollectCalendar = (opts: { timeoutMs?: number } = {}) => {
  const res = runCalendarCollector({ timeoutMs: opts.timeoutMs });
  if (!res.ran) {
    console.log(chalk.gray("calendar: skipped"), res.reason ?? "");
    return;
  }
  if (res.exitCode === 0) {
    console.log(chalk.gray("calendar: ok"));
  } else {
    console.log(
      chalk.yellow(`calendar: exit ${res.exitCode ?? "null"}`),
      res.reason ?? "",
    );
  }
};

export const cmdCollectGithub = async () => {
  const collected = await collectGithubSignals();
  let inserted = 0;
  for (const s of collected) {
    const id = `sig-${ulid()}`;
    const res = signals.insert({
      id,
      source: s.source,
      kind: s.kind,
      external_id: s.external_id,
      payload: s.payload,
      status: "new",
      triaged_at: null,
    } satisfies Omit<Signal, "created_at">);
    if (res.inserted) inserted++;
  }
  console.log(
    chalk.gray(`github signals: ${inserted} new (${collected.length} checked)`),
  );
};

export const cmdCollectClickup = async () => {
  const collected = await collectClickupSignals();
  let inserted = 0;
  for (const s of collected) {
    const id = `sig-${ulid()}`;
    const res = signals.insert({
      id,
      source: s.source,
      kind: s.kind,
      external_id: s.external_id,
      payload: s.payload,
      status: "new",
      triaged_at: null,
    } satisfies Omit<Signal, "created_at">);
    if (res.inserted) inserted++;
  }
  console.log(
    chalk.gray(
      `clickup signals: ${inserted} new (${collected.length} checked)`,
    ),
  );
};
