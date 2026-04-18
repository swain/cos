import {
  getDb,
  notifications,
  signals,
  sessions,
  workItems,
  cronTicks,
  cosLog,
} from "../db.js";
import type { WorkItem } from "../types.js";
import {
  flattenDashboard,
  SECTION_LIMIT,
  type InboxDashboard,
  type InboxItem,
} from "./types.js";

const QUEUE_TOP_N = 10;
const RECENT_WIN_WINDOW_MS = 24 * 60 * 60 * 1000;
const STALE_TICK_MINUTES = 20;

export type CronTickStatus = {
  id: string;
  started_at: string;
  age_minutes: number;
  stale: boolean;
  last_completed_at: string | null;
};

const minutesSinceSqliteTs = (ts: string): number => {
  const iso = ts.includes("T") ? ts : ts.replace(" ", "T");
  const withZ = iso.endsWith("Z") ? iso : `${iso}Z`;
  const t = new Date(withZ).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 60_000));
};

export const getCronTickStatus = (): CronTickStatus | null => {
  const active = cronTicks.current();
  if (!active) return null;
  const age = minutesSinceSqliteTs(active.started_at);
  const last = cosLog.recent(1)[0]?.tick_at ?? null;
  return {
    id: active.id,
    started_at: active.started_at,
    age_minutes: age,
    stale: age >= STALE_TICK_MINUTES,
    last_completed_at: last,
  };
};

const trimBody = (s: string, max = 200) =>
  s.length <= max ? s : s.slice(0, max - 1) + "…";

const parseTs = (iso: string): number => {
  const withZ = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  return new Date(withZ).getTime();
};

const ageMinutes = (iso: string): number =>
  Math.max(0, Math.round((Date.now() - parseTs(iso)) / 60_000));

const isGoodpartyPr = (url: string): boolean =>
  /github\.com\/thegoodparty\//.test(url);

const reposLabel = (repos: string[]): string =>
  repos.length ? repos.join(", ") : "—";

const isCosOnly = (repos: string[]): boolean =>
  repos.length > 0 && repos.every((r) => r === "cos");

const wiTitleMap = (): Map<string, string> => {
  const m = new Map<string, string>();
  for (const wi of workItems.list()) m.set(wi.id, wi.title);
  return m;
};

const needsDecisionItems = (): InboxItem[] => {
  const items: InboxItem[] = [];

  for (const n of notifications.listUnpushed()) {
    if (n.urgency !== "urgent") continue;
    items.push({
      key: `notification:${n.id}`,
      kind: "notification",
      id: n.id,
      section: "needsDecision",
      urgency: n.urgency,
      subject: n.subject,
      body: trimBody(n.body),
      related_ids: n.related_ids,
      created_at: n.created_at,
    });
  }

  for (const s of signals.list({ status: "new" })) {
    items.push({
      key: `signal:${s.id}`,
      kind: "signal",
      id: s.id,
      section: "needsDecision",
      urgency: "urgent",
      subject: `${s.kind} (${s.source})`,
      body: trimBody(s.external_id ?? JSON.stringify(s.payload)),
      related_ids: s.external_id ? [s.external_id] : [],
      created_at: s.created_at,
    });
  }

  for (const wi of workItems.list({ status: "queued" })) {
    if (!wi.needs_approval) continue;
    items.push({
      key: `work-item:${wi.id}`,
      kind: "work-item",
      id: wi.id,
      section: "needsDecision",
      urgency: "urgent",
      subject: `P${wi.priority} ${wi.title}`,
      body: trimBody(wi.description),
      related_ids: [],
      created_at: wi.created_at,
      meta: { priority: wi.priority, repos: reposLabel(wi.repos) },
    });
  }

  for (const wi of workItems.list({ status: "blocked" })) {
    if (wi.inbox_acked_at) continue;
    const lastSession = sessionSummaryForWorkItem(wi.id);
    items.push({
      key: `blocked-item:${wi.id}`,
      kind: "blocked-item",
      id: wi.id,
      section: "needsDecision",
      urgency: "urgent",
      subject: `BLOCKED P${wi.priority} ${wi.title}`,
      body: trimBody(lastSession ?? wi.description),
      related_ids: wi.pr_urls,
      created_at: wi.updated_at,
      meta: {
        priority: wi.priority,
        repos: reposLabel(wi.repos),
        reason: lastSession ?? "",
      },
    });
  }

  for (const wi of workItems.list({ status: "pr-open" })) {
    if (wi.inbox_acked_at) continue;
    if (isCosOnly(wi.repos)) continue;
    const gpPr = wi.pr_urls.find(isGoodpartyPr);
    if (!gpPr) continue;
    items.push({
      key: `pr-review:${wi.id}`,
      kind: "pr-review",
      id: wi.id,
      section: "needsDecision",
      urgency: "urgent",
      subject: `REVIEW: ${wi.title}`,
      body: trimBody(`PR awaiting your review — ${gpPr}`),
      related_ids: [gpPr, ...wi.pr_urls.filter((u) => u !== gpPr)],
      created_at: wi.updated_at,
      meta: { priority: wi.priority, repos: reposLabel(wi.repos), pr: gpPr },
    });
  }

  return items;
};

const sessionSummaryForWorkItem = (wiId: string): string | null => {
  const latest = getDb()
    .prepare(
      `SELECT status, notes, current_step, last_heartbeat FROM sessions
       WHERE work_item_id = ? ORDER BY started_at DESC LIMIT 1`,
    )
    .get(wiId) as
    | {
        status: string;
        notes: string | null;
        current_step: string | null;
        last_heartbeat: string;
      }
    | undefined;
  if (!latest) return null;
  if (latest.notes) return `last session ${latest.status}: ${latest.notes}`;
  return `last session ${latest.status}, step=${latest.current_step ?? "—"}`;
};

const activeItems = (titles: Map<string, string>): InboxItem[] => {
  const items: InboxItem[] = [];
  const statuses: ("running" | "starting" | "idle")[] = [
    "running",
    "starting",
    "idle",
  ];
  for (const status of statuses) {
    for (const sess of sessions.list({ status })) {
      const title = sess.work_item_id
        ? (titles.get(sess.work_item_id) ?? sess.work_item_id)
        : sess.kind;
      const hbAge = ageMinutes(sess.last_heartbeat);
      items.push({
        key: `worker:${sess.id}`,
        kind: "worker",
        id: sess.id,
        section: "active",
        urgency: "normal",
        subject: `${status.toUpperCase()} ${title}`,
        body: trimBody(
          `step=${sess.current_step ?? "—"} hb=${hbAge}m ago wi=${sess.work_item_id ?? "—"}`,
        ),
        related_ids: sess.work_item_id ? [sess.work_item_id] : [],
        created_at: sess.started_at,
        meta: {
          step: sess.current_step,
          last_heartbeat: sess.last_heartbeat,
          hb_age_minutes: hbAge,
          work_item_id: sess.work_item_id,
        },
      });
    }
  }
  return items;
};

const queueItems = (): InboxItem[] => {
  const rows = workItems
    .list({ status: "queued" })
    .filter((wi) => !wi.needs_approval)
    .slice(0, QUEUE_TOP_N);
  return rows.map((wi) => ({
    key: `queue-item:${wi.id}`,
    kind: "queue-item" as const,
    id: wi.id,
    section: "queue" as const,
    urgency: "normal" as const,
    subject: `P${wi.priority} ${wi.title}`,
    body: trimBody(`${reposLabel(wi.repos)} — ${wi.description}`),
    related_ids: [],
    created_at: wi.created_at,
    meta: { priority: wi.priority, repos: reposLabel(wi.repos) },
  }));
};

const recentWinItems = (): InboxItem[] => {
  const cutoff = Date.now() - RECENT_WIN_WINDOW_MS;
  const wins: WorkItem[] = [
    ...workItems.list({ status: "merged" }),
    ...workItems.list({ status: "done" }),
  ].filter((wi) => parseTs(wi.updated_at) >= cutoff);

  return wins
    .sort((a, b) => parseTs(b.updated_at) - parseTs(a.updated_at))
    .slice(0, SECTION_LIMIT)
    .map((wi) => ({
      key: `recent-win:${wi.id}`,
      kind: "recent-win" as const,
      id: wi.id,
      section: "recentWins" as const,
      urgency: "digest" as const,
      subject: `${wi.status.toUpperCase()} ${wi.title}`,
      body: trimBody(
        wi.pr_urls.length
          ? `PRs: ${wi.pr_urls.join(" · ")}`
          : reposLabel(wi.repos),
      ),
      related_ids: wi.pr_urls,
      created_at: wi.updated_at,
      meta: { priority: wi.priority, repos: reposLabel(wi.repos) },
    }));
};

const anomalyItems = (): InboxItem[] => {
  const items: InboxItem[] = [];
  for (const status of ["stale", "failed"] as const) {
    for (const sess of sessions.list({ status })) {
      if (sess.acked_at) continue;
      const hbAge = ageMinutes(sess.last_heartbeat);
      items.push({
        key: `session:${sess.id}`,
        kind: "session",
        id: sess.id,
        section: "anomalies",
        urgency: "normal",
        subject: `${status.toUpperCase()} session ${sess.id}`,
        body: trimBody(
          `wi=${sess.work_item_id ?? "—"} step=${sess.current_step ?? "—"} hb=${hbAge}m ago${
            sess.notes ? ` — ${sess.notes}` : ""
          }`,
        ),
        related_ids: sess.work_item_id ? [sess.work_item_id] : [],
        created_at: sess.started_at,
        meta: {
          session_status: status,
          hb_age_minutes: hbAge,
          last_heartbeat: sess.last_heartbeat,
          notes: sess.notes,
          work_item_id: sess.work_item_id,
        },
      });
    }
  }
  return items;
};

const notificationTail = (
  urgency: "normal" | "digest",
  section: "fyi" | "digest",
): InboxItem[] =>
  notifications
    .listUnpushed()
    .filter((n) => n.urgency === urgency)
    .map((n) => ({
      key: `notification:${n.id}`,
      kind: "notification" as const,
      id: n.id,
      section,
      urgency: n.urgency,
      subject: n.subject,
      body: trimBody(n.body),
      related_ids: n.related_ids,
      created_at: n.created_at,
    }));

export const collectDashboard = (): InboxDashboard => {
  const titles = wiTitleMap();
  return {
    needsDecision: needsDecisionItems().sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    ),
    active: activeItems(titles),
    queue: queueItems(),
    recentWins: recentWinItems(),
    anomalies: anomalyItems(),
    fyi: notificationTail("normal", "fyi").slice(0, SECTION_LIMIT),
    digest: notificationTail("digest", "digest").slice(0, SECTION_LIMIT),
  };
};

export const collectInbox = (): InboxItem[] =>
  flattenDashboard(collectDashboard());
