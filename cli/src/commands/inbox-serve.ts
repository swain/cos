import { createServer, IncomingMessage, ServerResponse } from "node:http";
import chalk from "chalk";
import { getDb } from "../db.js";
import {
  collectDashboard,
  getCronTickStatus,
  type CronTickStatus,
} from "../inbox/data.js";
import {
  acceptIdea,
  ackNotification,
  approveWorkItem,
  abandonWorkItem,
  archiveWorkItem,
  bumpWorkItem,
  deferIdea,
  dismissSession,
  dispatchWorkItem,
  enqueueInboxResponse,
  killIdea,
  killSession,
  markAllFyiRead,
  markPrReviewed,
  peekSession,
  promoteIdea,
  retrySession,
  retryWorkItem,
  reviewInPlannotator,
  snoozeWorkItem,
  startReviewQueue,
  suppressSignal,
  viewFailureLog,
  type ActionResult,
} from "../inbox/actions.js";
import {
  SECTION_TITLES,
  type InboxDashboard,
  type InboxItem,
} from "../inbox/types.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.COS_INBOX_PORT) || 4411;

const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const relTime = (iso: string): string => {
  const t = iso.endsWith("Z") || iso.includes("+") ? iso : iso + "Z";
  const then = new Date(t).getTime();
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  return `${day}d`;
};

// Editorial/newspaper light palette. Warm off-white paper, serif display,
// sharp verdict accents. Dark mode flips the whole palette via
// prefers-color-scheme so a user in a dark OS still gets a usable surface.
const styles = `
:root {
  color-scheme: light;
  --bg: #faf7f2;
  --paper: #ffffff;
  --fg: #14161b;
  --fg-soft: #373a42;
  --muted: #6b6e76;
  --muted-2: #9a9ca2;
  --rule: #e8e3d6;
  --rule-strong: #c8c2b0;
  --accent: #1a4fa8;
  --accent-bg: #e7eefb;
  --red: #a12a1f;
  --red-bg: #fbe8e4;
  --amber: #8a5d0b;
  --amber-bg: #fbf1d7;
  --green: #1f6b3f;
  --green-bg: #e3f1e8;
  --green-fg: #155b32;
  --shadow: 0 1px 0 rgba(20, 18, 12, 0.04), 0 4px 14px rgba(20, 18, 12, 0.035);
  --font-display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, ui-serif, serif;
  --font-body: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #101115;
    --paper: #17191f;
    --fg: #ececef;
    --fg-soft: #c9cace;
    --muted: #8d9098;
    --muted-2: #5e6067;
    --rule: #262932;
    --rule-strong: #3a3e49;
    --accent: #8fb6ff;
    --accent-bg: #18233b;
    --red: #e87268;
    --red-bg: #3a1b18;
    --amber: #e0b05a;
    --amber-bg: #2d2310;
    --green: #6ec98b;
    --green-bg: #12261a;
    --green-fg: #8fd6a3;
    --shadow: 0 1px 0 rgba(0, 0, 0, 0.3), 0 4px 14px rgba(0, 0, 0, 0.25);
  }
}

* { box-sizing: border-box; }
html, body { background: var(--bg); }
body {
  margin: 0 auto;
  padding: 48px 28px 96px;
  color: var(--fg);
  font-family: var(--font-body);
  font-size: 14px;
  line-height: 1.5;
  max-width: 880px;
  -webkit-font-smoothing: antialiased;
}

/* Masthead — serif nameplate, thin hairline rule beneath, refresh meta in mono. */
.masthead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule-strong);
  margin-bottom: 32px;
}
.masthead h1 {
  font-family: var(--font-display);
  font-weight: 400;
  font-style: italic;
  font-size: 38px;
  line-height: 1;
  letter-spacing: -0.01em;
  margin: 0;
}
.masthead h1 .count {
  font-style: normal;
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  color: var(--muted);
  margin-left: 10px;
  vertical-align: 2px;
}
.masthead .meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
  white-space: nowrap;
}

.tick-banner {
  background: var(--accent-bg);
  color: var(--fg);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--accent);
  border-radius: 4px;
  padding: 10px 14px;
  margin-bottom: 28px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.tick-banner.stale { border-left-color: var(--red); background: var(--red-bg); color: var(--red); }
.tick-banner .id { color: var(--muted); margin-left: 8px; }

/* ----- Section header ----- */
.section { margin-bottom: 56px; }
.section__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 18px;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--fg);
}
.section__title {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 28px;
  line-height: 1;
  letter-spacing: -0.005em;
  margin: 0;
}
.section__count {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.section__head-actions {
  display: flex;
  gap: 8px;
}

.section.section--fyi .section__head { border-bottom-color: var(--rule-strong); }
.section.section--fyi .section__title { color: var(--fg-soft); }

.empty {
  color: var(--muted);
  font-style: italic;
  padding: 8px 0 14px;
  font-size: 13px;
}
.zero-state {
  text-align: center;
  padding: 80px 20px;
  font-family: var(--font-display);
  font-style: italic;
  font-size: 20px;
  color: var(--muted);
}
.zero-state .sig {
  display: block;
  margin-top: 18px;
  font-family: var(--font-mono);
  font-style: normal;
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted-2);
}

/* ----- Card: shared shell for review + FYI rows ----- */
.card {
  position: relative;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-left-width: 3px;
  border-radius: 6px;
  padding: 14px 16px;
  margin-bottom: 10px;
  box-shadow: var(--shadow);
}
.card--urgent { border-left-color: var(--red); }
.card--blocked { border-left-color: var(--red); background: var(--red-bg); }
.card--pr { border-left-color: var(--accent); }
.card--approval { border-left-color: var(--amber); }
.card--idea-your-call { border-left-color: var(--amber); }
.card--fyi { border-left-color: var(--rule-strong); }
.card--digest { border-left-color: var(--muted-2); }

.card__head {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}
.card__body { flex: 1; min-width: 0; }
.card__subject {
  font-weight: 600;
  font-size: 14.5px;
  line-height: 1.35;
  color: var(--fg);
  word-break: break-word;
}
.card--pr .card__subject,
.card--blocked .card__subject,
.card--idea-your-call .card__subject { font-size: 15.5px; }

.card__text {
  color: var(--fg-soft);
  margin-top: 4px;
  font-size: 13px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.card__meta {
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 14px;
  flex-wrap: wrap;
}
.card__meta a { color: var(--accent); text-decoration: none; }
.card__meta a:hover { text-decoration: underline; }
.card__meta .kind {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted-2);
}

/* ----- Actions ----- */
.actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  flex-wrap: wrap;
  align-items: flex-start;
}
.actions form { margin: 0; }
.btn {
  font-family: inherit;
  font-size: 12.5px;
  padding: 5px 12px;
  border-radius: 4px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--fg-soft);
  cursor: pointer;
  line-height: 1.3;
  white-space: nowrap;
  text-decoration: none;
  display: inline-block;
  transition: background 0.08s ease, border-color 0.08s ease, color 0.08s ease;
}
.btn:hover { background: var(--rule); }
.btn--primary {
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
  padding: 6px 14px;
}
.btn--primary:hover { background: var(--accent-bg); }
.btn--promote, .btn--accept-promote {
  border-color: var(--green);
  color: var(--green-fg);
  font-weight: 600;
}
.btn--promote:hover, .btn--accept-promote:hover { background: var(--green-bg); }
.btn--kill, .btn--accept-kill, .btn--danger {
  border-color: var(--red);
  color: var(--red);
}
.btn--kill:hover, .btn--accept-kill:hover, .btn--danger:hover { background: var(--red-bg); }
.btn--muted { color: var(--muted); border-color: var(--rule); }
.btn--muted:hover { background: var(--rule); color: var(--fg-soft); }
.btn[disabled] { opacity: 0.5; cursor: not-allowed; }

.nl-form {
  display: flex;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--rule);
}
.nl-form input[type=text] {
  flex: 1;
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  padding: 5px 10px;
  font-size: 12.5px;
  font-family: inherit;
}
.nl-form input[type=text]:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--paper);
}
.nl-form button {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 5px 14px;
  font-size: 12.5px;
  cursor: pointer;
  font-family: inherit;
}
.nl-form button:hover { background: var(--accent-bg); }

/* ----- Idea details disclosure ----- */
.idea__rationale {
  margin-top: 10px;
  color: var(--fg-soft);
  font-size: 13.5px;
  line-height: 1.55;
  word-break: break-word;
  white-space: pre-wrap;
}
.idea__meta {
  margin-top: 10px;
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.idea__meta .tag { color: var(--muted-2); }
.idea__meta .score .v { color: var(--fg); }

/* ----- Expanders (recent wins, triaged ideas) ----- */
.disclosure {
  margin-top: 12px;
  padding: 10px 14px;
  background: var(--paper);
  border: 1px dashed var(--rule-strong);
  border-radius: 6px;
}
.disclosure summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  letter-spacing: 0.04em;
  user-select: none;
}
.disclosure summary::-webkit-details-marker { display: none; }
.disclosure summary::before {
  content: "▸";
  font-size: 9px;
  transition: transform 0.12s ease-out;
}
.disclosure[open] summary::before { transform: rotate(90deg); }
.disclosure summary .label { color: var(--fg-soft); text-transform: uppercase; }
.disclosure summary .n { color: var(--fg); font-weight: 700; }
.disclosure__body {
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--rule);
}

.browse-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 10px 14px;
  margin-top: 10px;
  background: var(--paper);
  border: 1px dashed var(--rule-strong);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}

.bulk {
  margin-top: 18px;
  display: flex;
  justify-content: flex-end;
}

.confirm { color: var(--amber); font-size: 12px; margin-left: 10px; }
`;

const isHttpUrl = (s: string): boolean =>
  s.startsWith("http://") || s.startsWith("https://");

const renderRelated = (ids: string[]): string =>
  ids
    .map((id) =>
      isHttpUrl(id)
        ? `<a href="${escapeHtml(id)}" target="_blank" rel="noopener">${escapeHtml(id)}</a>`
        : escapeHtml(id),
    )
    .join(" · ");

const hiddenReturn = (to: string): string =>
  `<input type="hidden" name="returnTo" value="${escapeHtml(to)}">`;

const btn = (
  action: string,
  label: string,
  returnTo: string,
  cls = "btn",
): string =>
  `<form method="post" action="${action}">${hiddenReturn(returnTo)}<button class="${cls}">${label}</button></form>`;

const cardAccentClass = (item: InboxItem): string => {
  if (item.kind === "pr-review") return "card--pr";
  if (item.kind === "blocked-item") return "card--blocked";
  if (item.kind === "work-item") return "card--approval";
  if (item.kind === "idea") return "card--idea-your-call";
  if (item.kind === "recent-win") return "card--digest";
  if (item.section === "fyi") return "card--fyi";
  return "card--urgent";
};

const firstLine = (s: string, max = 140): string => {
  const line = s.split(/\r?\n/)[0] ?? "";
  const trimmed = line.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + "…" : trimmed;
};

const renderReviewActions = (item: InboxItem, returnTo: string): string => {
  const id = encodeURIComponent(item.id);
  const key = encodeURIComponent(item.key);
  const rtn = hiddenReturn(returnTo);
  switch (item.kind) {
    case "pr-review": {
      const pr = item.related_ids.find(isHttpUrl);
      const primary = pr
        ? `<form method="post" action="/work-items/${id}/review-plannotator">${rtn}<input type="hidden" name="prUrl" value="${escapeHtml(pr)}"><button class="btn btn--primary">Review in plannotator</button></form>`
        : "";
      const openGithub = pr
        ? `<a class="btn" href="${escapeHtml(pr)}" target="_blank" rel="noopener">open on GitHub</a>`
        : "";
      return (
        primary +
        openGithub +
        btn(
          `/work-items/${id}/pr-reviewed`,
          "mark reviewed",
          returnTo,
          "btn btn--muted",
        )
      );
    }
    case "blocked-item":
      return (
        btn(`/work-items/${id}/retry`, "retry", returnTo, "btn btn--primary") +
        btn(`/work-items/${id}/failure-log`, "view log", returnTo, "btn") +
        btn(`/work-items/${id}/abandon`, "abandon", returnTo, "btn btn--danger")
      );
    case "work-item":
      return (
        btn(
          `/work-items/${id}/approve`,
          "approve &amp; dispatch",
          returnTo,
          "btn btn--primary",
        ) +
        btn(`/work-items/${id}/snooze`, "snooze", returnTo, "btn btn--muted")
      );
    case "notification":
      return btn(
        `/notifications/${id}/ack`,
        "ack",
        returnTo,
        "btn btn--primary",
      );
    case "signal":
      return btn(
        `/signals/${id}/suppress`,
        "suppress",
        returnTo,
        "btn btn--danger",
      );
    case "idea":
      return (
        `<form method="post" action="/ideas/${id}/promote">${rtn}<button class="btn btn--promote">promote</button></form>` +
        `<form method="post" action="/ideas/${id}/kill">${rtn}<button class="btn btn--kill">kill</button></form>` +
        `<form method="post" action="/ideas/${id}/defer">${rtn}<button class="btn btn--muted">defer 7d</button></form>`
      );
    default:
      void key;
      return "";
  }
};

const renderFyiActions = (item: InboxItem, returnTo: string): string => {
  const id = encodeURIComponent(item.id);
  switch (item.kind) {
    case "notification":
      return btn(
        `/notifications/${id}/ack`,
        "mark read",
        returnTo,
        "btn btn--muted",
      );
    case "session":
      return btn(
        `/sessions/${id}/dismiss`,
        "dismiss",
        returnTo,
        "btn btn--muted",
      );
    case "recent-win":
      return btn(
        `/work-items/${id}/pr-reviewed`,
        "dismiss",
        returnTo,
        "btn btn--muted",
      );
    default:
      return "";
  }
};

const renderIdeaBody = (item: InboxItem): string => {
  const m = item.ideaMeta;
  if (!m) return "";
  const confPct = Math.round(m.confidence * 100);
  const scorePct = Math.round(m.score * 100);
  const meta: string[] = [];
  if (m.sourceTag)
    meta.push(`<span class="tag">${escapeHtml(m.sourceTag)}</span>`);
  meta.push(
    `<span class="score">score <span class="v">${scorePct}</span> · conf <span class="v">${confPct}</span></span>`,
  );
  for (const r of m.repos_guess)
    meta.push(`<span class="tag">${escapeHtml(r)}</span>`);
  const rationale = m.rationale
    ? `<p class="idea__rationale">${escapeHtml(m.rationale)}</p>`
    : "";
  return `${rationale}<div class="idea__meta">${meta.join("")}</div>`;
};

const renderCard = (
  item: InboxItem,
  returnTo: string,
  variant: "review" | "fyi",
): string => {
  const accent = cardAccentClass(item);
  const related = renderRelated(item.related_ids);
  const metaExtras = item.meta
    ? Object.entries(item.meta)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(
          ([k, v]) =>
            `<span>${escapeHtml(k)}=${escapeHtml(String(v).slice(0, 80))}</span>`,
        )
        .join("")
    : "";
  const isIdea = item.kind === "idea";
  const bodyHtml = isIdea
    ? renderIdeaBody(item)
    : item.body
      ? `<div class="card__text">${escapeHtml(firstLine(item.body, 240))}</div>`
      : "";
  const actions =
    variant === "review"
      ? renderReviewActions(item, returnTo)
      : renderFyiActions(item, returnTo);

  const idLabel = item.displayLabel ?? item.id;
  const nlForm =
    variant === "review"
      ? `<form class="nl-form" method="post" action="/inbox/rows/${encodeURIComponent(item.key)}/respond">
          ${hiddenReturn(returnTo)}
          <input type="text" name="text" placeholder="reply in plain English — enqueues a work item for Po">
          <button>send</button>
        </form>`
      : "";

  return `
<article class="card ${accent}" id="row-${escapeHtml(item.key)}">
  <div class="card__head">
    <div class="card__body">
      <div class="card__subject">${escapeHtml(item.subject)}</div>
      ${bodyHtml}
      <div class="card__meta">
        <span class="kind">${escapeHtml(item.kind)}</span>
        <span>${relTime(item.created_at)} ago</span>
        ${related ? `<span>${related}</span>` : ""}
        ${metaExtras}
        <span>${escapeHtml(idLabel)}</span>
      </div>
    </div>
    <div class="actions">${actions}</div>
  </div>
  ${nlForm}
</article>`;
};

const findPrUrls = (items: InboxItem[]): string[] => {
  const urls: string[] = [];
  for (const it of items) {
    if (it.kind !== "pr-review") continue;
    const pr = it.related_ids.find(isHttpUrl);
    if (pr) urls.push(pr);
  }
  return urls;
};

// Per-row anchor so a form submit redirects to the NEXT sibling row — this
// keeps scroll position stable when acting on rows mid-page (wi-47 invariant).
const nextAnchor = (
  items: InboxItem[],
  i: number,
  sectionId: string,
): string =>
  i + 1 < items.length
    ? `/#row-${encodeURIComponent(items[i + 1].key)}`
    : `/#${sectionId}`;

const renderReviewSection = (items: InboxItem[]): string => {
  const sectionAnchor = "/#section-review";
  const prUrls = findPrUrls(items);
  const queueBtn =
    prUrls.length > 1
      ? `<form method="post" action="/inbox/review-queue-start">${hiddenReturn(sectionAnchor)}<button class="btn btn--primary">Start review queue (${prUrls.length})</button></form>`
      : "";
  const head = `<div class="section__head">
      <div>
        <h2 class="section__title">${SECTION_TITLES.review}</h2>
      </div>
      <div class="section__head-actions">
        <span class="section__count">${items.length} ${items.length === 1 ? "item" : "items"}</span>
        ${queueBtn}
      </div>
    </div>`;
  const body = items.length
    ? items
        .map((it, i) =>
          renderCard(it, nextAnchor(items, i, "section-review"), "review"),
        )
        .join("")
    : `<div class="empty">Nothing blocking. Nice.</div>`;
  return `<section class="section section--review" id="section-review">${head}${body}</section>`;
};

const renderRecentWinsDisclosure = (items: InboxItem[]): string => {
  if (!items.length) return "";
  // Stay-open on reload: add `open` whenever returnTo lands here, so dismissing
  // a single row doesn't re-collapse the whole group.
  const body = items
    .map((it, i) => renderCard(it, nextAnchor(items, i, "recent-wins"), "fyi"))
    .join("");
  return `<details class="disclosure" id="recent-wins">
    <summary><span class="label">Recent wins</span> <span class="n">${items.length}</span> shipped in the last 24h</summary>
    <div class="disclosure__body">${body}</div>
  </details>`;
};

const renderFyiSection = (dashboard: InboxDashboard): string => {
  const { fyi, recentWins, triagedIdeasCount } = dashboard;
  const sectionAnchor = "/#section-fyi";
  const head = `<div class="section__head">
      <div>
        <h2 class="section__title">${SECTION_TITLES.fyi}</h2>
      </div>
      <div class="section__head-actions">
        <span class="section__count">${fyi.length} ${fyi.length === 1 ? "item" : "items"}</span>
      </div>
    </div>`;
  const body = fyi.length
    ? fyi
        .map((it, i) =>
          renderCard(it, nextAnchor(fyi, i, "section-fyi"), "fyi"),
        )
        .join("")
    : `<div class="empty">All quiet.</div>`;
  const recent = renderRecentWinsDisclosure(recentWins);
  const ideasLine =
    triagedIdeasCount > 0
      ? `<div class="browse-line"><span><strong style="color:var(--fg)">${triagedIdeasCount}</strong> triaged ideas awaiting a sweep</span><span>run <code>cos ideas --status new</code> to browse</span></div>`
      : "";
  const bulk =
    fyi.length > 0
      ? `<div class="bulk"><form method="post" action="/inbox/mark-all-fyi-read">${hiddenReturn(sectionAnchor)}<button class="btn btn--muted">mark all FYI read</button></form></div>`
      : "";
  return `<section class="section section--fyi" id="section-fyi">${head}${body}${recent}${ideasLine}${bulk}</section>`;
};

const renderTickBanner = (tick: CronTickStatus | null): string => {
  if (!tick) return "";
  const stale = tick.stale ? " stale" : "";
  const staleSuffix = tick.stale
    ? ` · looks stale — last completed ${escapeHtml(tick.last_completed_at ?? "never")}`
    : "";
  return `<div class="tick-banner${stale}">⟳ Cron tick in progress (started ${tick.age_minutes}m ago)${staleSuffix}<span class="id">${escapeHtml(tick.id)}</span></div>`;
};

const clientScript = `(function(){
  if (typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
  var POLL_MS = 5000;
  var isTyping = function(){
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
  };
  var refresh = function(){
    if (isTyping()) return;
    if (document.hidden) return;
    fetch('/', { headers: { 'Cache-Control': 'no-cache' } })
      .then(function(r){ if (!r.ok) throw new Error('bad status'); return r.text(); })
      .then(function(html){
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var fresh = doc.getElementById('inbox-main');
        var cur = document.getElementById('inbox-main');
        if (fresh && cur) cur.innerHTML = fresh.innerHTML;
      })
      .catch(function(){});
  };
  setInterval(refresh, POLL_MS);
})();`;

const renderPage = (
  dashboard: InboxDashboard,
  tick: CronTickStatus | null,
): string => {
  const total = dashboard.review.length + dashboard.fyi.length;
  const now = new Date().toLocaleTimeString();
  const zeroState =
    total === 0 && dashboard.recentWins.length === 0
      ? `<div class="zero-state">Inbox empty. Po has nothing for you.<span class="sig">— Po</span></div>`
      : "";
  const reviewSection = renderReviewSection(dashboard.review);
  const fyiSection = renderFyiSection(dashboard);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<noscript><meta http-equiv="refresh" content="15"></noscript>
<title>Inbox${total ? ` (${total})` : ""}</title>
<style>${styles}</style>
</head>
<body>
<div id="inbox-main">
<header class="masthead">
  <h1>Inbox${total ? `<span class="count">${total}</span>` : ""}</h1>
  <div class="meta">refreshed ${now} · polls every 5s</div>
</header>
${renderTickBanner(tick)}
${zeroState || reviewSection + fyiSection}
</div>
<script>${clientScript}</script>
</body>
</html>`;
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });

const parseForm = (body: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const pair of body.split("&")) {
    if (!pair) continue;
    const [k, v = ""] = pair.split("=");
    out[decodeURIComponent(k.replace(/\+/g, " "))] = decodeURIComponent(
      v.replace(/\+/g, " "),
    );
  }
  return out;
};

const sendRedirect = (res: ServerResponse, to = "/") => {
  res.writeHead(303, { Location: to });
  res.end();
};

const sendText = (res: ServerResponse, code: number, body: string) => {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
};

const sendHtml = (res: ServerResponse, body: string) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
};

const safeReturn = (v: string | undefined): string => {
  if (!v) return "/";
  if (!v.startsWith("/")) return "/";
  if (v.startsWith("//")) return "/";
  return v;
};

const finish = (res: ServerResponse, r: ActionResult, returnTo = "/") =>
  r.ok ? sendRedirect(res, returnTo) : sendText(res, 500, r.message);

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const [pathRaw] = url.split("?");
  const path = decodeURI(pathRaw);

  try {
    if (method === "GET" && path === "/") {
      sendHtml(res, renderPage(collectDashboard(), getCronTickStatus()));
      return;
    }
    if (method === "GET" && path === "/healthz") {
      sendText(res, 200, "ok");
      return;
    }
    if (method !== "POST") {
      sendText(res, 404, "not found");
      return;
    }

    const raw = await readBody(req);
    const form = parseForm(raw);
    const returnTo = safeReturn(form.returnTo);

    const routes: [RegExp, (m: RegExpMatchArray) => Promise<ActionResult>][] = [
      [
        /^\/notifications\/([^/]+)\/ack$/,
        (m) => ackNotification(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/approve$/,
        (m) => approveWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/dispatch$/,
        (m) => dispatchWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/snooze$/,
        (m) => snoozeWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/bump$/,
        (m) => bumpWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/archive$/,
        (m) => archiveWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/abandon$/,
        (m) => abandonWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/retry$/,
        (m) => retryWorkItem(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/pr-reviewed$/,
        (m) => markPrReviewed(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/failure-log$/,
        (m) => viewFailureLog(decodeURIComponent(m[1])),
      ],
      [
        /^\/work-items\/([^/]+)\/review-plannotator$/,
        () => reviewInPlannotator(form.prUrl ?? ""),
      ],
      [
        /^\/signals\/([^/]+)\/suppress$/,
        (m) => suppressSignal(decodeURIComponent(m[1])),
      ],
      [
        /^\/sessions\/([^/]+)\/dismiss$/,
        (m) => dismissSession(decodeURIComponent(m[1])),
      ],
      [
        /^\/sessions\/([^/]+)\/kill$/,
        (m) => killSession(decodeURIComponent(m[1])),
      ],
      [
        /^\/sessions\/([^/]+)\/retry$/,
        (m) => retrySession(decodeURIComponent(m[1])),
      ],
      [
        /^\/sessions\/([^/]+)\/peek$/,
        (m) => peekSession(decodeURIComponent(m[1])),
      ],
      [
        /^\/sessions\/([^/]+)\/ack$/,
        (m) => dismissSession(decodeURIComponent(m[1])),
      ],
      [
        /^\/ideas\/([^/]+)\/promote$/,
        (m) => promoteIdea(decodeURIComponent(m[1])),
      ],
      [/^\/ideas\/([^/]+)\/kill$/, (m) => killIdea(decodeURIComponent(m[1]))],
      [/^\/ideas\/([^/]+)\/defer$/, (m) => deferIdea(decodeURIComponent(m[1]))],
      [
        /^\/ideas\/([^/]+)\/accept$/,
        (m) => acceptIdea(decodeURIComponent(m[1])),
      ],
    ];

    for (const [re, handler] of routes) {
      const m = path.match(re);
      if (!m) continue;
      const result = await handler(m);
      if (result.detail) {
        return sendText(res, 200, `${result.message}\n\n${result.detail}`);
      }
      return finish(res, result, returnTo);
    }

    const respond = path.match(/^\/inbox\/rows\/([^/]+)\/respond$/);
    if (respond) {
      const rowKey = decodeURIComponent(respond[1]);
      const text = form.text ?? "";
      return finish(res, await enqueueInboxResponse(rowKey, text), returnTo);
    }

    if (path === "/inbox/mark-all-fyi-read") {
      return finish(res, await markAllFyiRead(collectDashboard()), returnTo);
    }

    if (path === "/inbox/review-queue-start") {
      const dashboard = collectDashboard();
      const urls = findPrUrls(dashboard.review);
      const r = await startReviewQueue(urls);
      if (r.detail) return sendText(res, 200, `${r.message}\n\n${r.detail}`);
      return finish(res, r, returnTo);
    }

    sendText(res, 404, "not found");
  } catch (e: any) {
    console.error(chalk.red(`[inbox] ${method} ${path}: ${e.message}`));
    sendText(res, 500, `error: ${e.message}`);
  }
};

export const cmdInboxServe = () => {
  getDb();
  const server = createServer((req, res) => {
    void handle(req, res);
  });
  server.listen(PORT, HOST, () => {
    console.log(chalk.green(`inbox listening on http://${HOST}:${PORT}`));
  });
  const shutdown = (sig: string) => {
    console.log(chalk.gray(`[inbox] received ${sig}, closing`));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};
