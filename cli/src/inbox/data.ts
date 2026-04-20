import {
  getDb,
  notifications,
  signals,
  sessions,
  workItems,
  cronTicks,
  cosLog,
  ideas,
} from "../db.js";
import { displayWorkItemId } from "../util.js";
import type { Idea, TriageVerdict, WorkItem } from "../types.js";
import {
  flattenDashboard,
  FYI_AUTO_READ_MS,
  IDEAS_TOP_N,
  SECTION_LIMIT,
  type IdeasSectionStats,
  type InboxDashboard,
  type InboxItem,
} from "./types.js";

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

const wiDisplayIdMap = (): Map<string, string> => {
  const m = new Map<string, string>();
  for (const wi of workItems.list()) m.set(wi.id, displayWorkItemId(wi));
  return m;
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

// Sort scored ideas the way the user wants to see them: confidence desc,
// score as tiebreak. Only your-call ideas end up in Review — suggest-* are
// hidden behind the "N triaged — browse" affordance.
const sortYourCallIdeas = (scored: Idea[]): Idea[] =>
  [...scored].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (b.triage_score ?? 0) - (a.triage_score ?? 0);
  });

const TITLE_PREFIX_RE = /^\[([^\]]+)\]\s*/;

const parseIdeaTitle = (
  raw: string,
): { subject: string; sourceTag: string | null } => {
  const m = raw.match(TITLE_PREFIX_RE);
  if (!m) return { subject: raw, sourceTag: null };
  return { subject: raw.slice(m[0].length), sourceTag: m[1] };
};

const ideaToItem = (i: Idea): InboxItem => {
  const { subject, sourceTag } = parseIdeaTitle(i.title);
  return {
    key: `idea:${i.id}`,
    kind: "idea",
    id: i.id,
    section: "review",
    urgency: "normal",
    subject,
    body: i.triage_rationale ?? trimBody(i.description, 160),
    related_ids: [],
    created_at: i.created_at,
    ideaMeta: {
      verdict: i.triage_verdict as TriageVerdict,
      rationale: i.triage_rationale ?? "",
      score: i.triage_score ?? 0,
      confidence: i.confidence,
      repos_guess: i.repos_guess,
      sourceTag,
    },
  };
};

const reviewItems = (): InboxItem[] => {
  const items: InboxItem[] = [];

  for (const n of notifications.listUnpushed()) {
    if (n.urgency !== "urgent") continue;
    items.push({
      key: `notification:${n.id}`,
      kind: "notification",
      id: n.id,
      section: "review",
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
      section: "review",
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
      displayLabel: displayWorkItemId(wi),
      section: "review",
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
      displayLabel: displayWorkItemId(wi),
      section: "review",
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
      displayLabel: displayWorkItemId(wi),
      section: "review",
      urgency: "urgent",
      subject: wi.title,
      body: trimBody(`PR awaiting your review — ${gpPr}`),
      related_ids: [gpPr, ...wi.pr_urls.filter((u) => u !== gpPr)],
      created_at: wi.updated_at,
      meta: { priority: wi.priority, repos: reposLabel(wi.repos), pr: gpPr },
    });
  }

  const scoredIdeas = ideas
    .list({ status: "new" })
    .filter((i) => i.triaged_at !== null && i.triage_verdict === "your-call");
  for (const i of sortYourCallIdeas(scoredIdeas)) {
    items.push(ideaToItem(i));
  }

  return items;
};

const withinFyiWindow = (iso: string): boolean =>
  Date.now() - parseTs(iso) < FYI_AUTO_READ_MS;

const anomalyItems = (displayIds: Map<string, string>): InboxItem[] => {
  const items: InboxItem[] = [];
  for (const status of ["stale", "failed"] as const) {
    for (const sess of sessions.list({ status })) {
      if (sess.acked_at) continue;
      const hbAge = ageMinutes(sess.last_heartbeat);
      const wiDisplay = sess.work_item_id
        ? (displayIds.get(sess.work_item_id) ?? sess.work_item_id)
        : "—";
      items.push({
        key: `session:${sess.id}`,
        kind: "session",
        id: sess.id,
        section: "fyi",
        urgency: "normal",
        subject: `${status.toUpperCase()} session ${sess.id}`,
        body: trimBody(
          `wi=${wiDisplay} step=${sess.current_step ?? "—"} hb=${hbAge}m ago${
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
          work_item_id: wiDisplay,
        },
      });
    }
  }
  return items;
};

const fyiItems = (displayIds: Map<string, string>): InboxItem[] => {
  const items: InboxItem[] = [];

  for (const n of notifications.listUnpushed()) {
    if (n.urgency === "urgent") continue;
    items.push({
      key: `notification:${n.id}`,
      kind: "notification",
      id: n.id,
      section: "fyi",
      urgency: n.urgency,
      subject: n.subject,
      body: trimBody(n.body),
      related_ids: n.related_ids,
      created_at: n.created_at,
    });
  }

  for (const a of anomalyItems(displayIds)) items.push(a);

  return items
    .filter((i) => withinFyiWindow(i.created_at))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, SECTION_LIMIT * 2);
};

const recentWinItems = (): InboxItem[] => {
  const cutoff = Date.now() - RECENT_WIN_WINDOW_MS;
  const wins: WorkItem[] = [
    ...workItems.list({ status: "merged" }),
    ...workItems.list({ status: "done" }),
  ].filter((wi) => !wi.inbox_acked_at && parseTs(wi.updated_at) >= cutoff);

  return wins
    .sort((a, b) => parseTs(b.updated_at) - parseTs(a.updated_at))
    .slice(0, SECTION_LIMIT)
    .map((wi) => ({
      key: `recent-win:${wi.id}`,
      kind: "recent-win" as const,
      id: wi.id,
      displayLabel: displayWorkItemId(wi),
      section: "fyi" as const,
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

const triagedIdeasCount = (): number =>
  ideas
    .list({ status: "new" })
    .filter(
      (i) =>
        i.triaged_at !== null &&
        (i.triage_verdict === "suggest-promote" ||
          i.triage_verdict === "suggest-kill"),
    ).length;

export const collectDashboard = (): InboxDashboard => {
  const displayIds = wiDisplayIdMap();
  return {
    review: reviewItems().sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    ),
    fyi: fyiItems(displayIds),
    recentWins: recentWinItems(),
    triagedIdeasCount: triagedIdeasCount(),
  };
};

// Kept for IDEAS section tests + the triaged-browse expander.
export const collectIdeasStats = (): IdeasSectionStats => {
  const all = ideas.list({ status: "new" });
  const scored = all.filter(
    (i) => i.triaged_at !== null && i.triage_verdict !== null,
  );
  return {
    topN: IDEAS_TOP_N,
    scoredTotal: scored.length,
    unscoredTotal: all.length - scored.length,
  };
};

export const collectInbox = (): InboxItem[] =>
  flattenDashboard(collectDashboard());
