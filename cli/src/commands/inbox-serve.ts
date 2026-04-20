import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import chalk from "chalk";
import { getDb } from "../db.js";
import { COS_DIR, MEETINGS_DIR } from "../util.js";
import {
  collectDashboard,
  getCronTickStatus,
  type CronTickStatus,
} from "../inbox/data.js";
import {
  acceptIdea,
  ackNotification,
  approvePlan,
  approveWorkItem,
  abandonWorkItem,
  archiveWorkItem,
  bumpWorkItem,
  deferIdea,
  dismissPlan,
  dismissSession,
  dispatchWorkItem,
  enqueueInboxResponse,
  killIdea,
  killSession,
  markAllFyiRead,
  markPrReviewed,
  openPrepFile,
  peekSession,
  prepMeetingNow,
  promoteIdea,
  reconcileOrphanedPrepRuns,
  retrySession,
  retryWorkItem,
  reviewInPlannotator,
  reviewPlanInPlannotator,
  snoozeWorkItem,
  startReviewQueue,
  submitPlanFeedback,
  suppressSignal,
  viewFailureLog,
  type ActionResult,
} from "../inbox/actions.js";
import { plans } from "../db.js";
import {
  SECTION_TITLES,
  type InboxDashboard,
  type InboxItem,
} from "../inbox/types.js";
import {
  findUpcomingMeetingById,
  invalidateUpcomingCache,
} from "../inbox/upcoming.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.COS_INBOX_PORT) || 4411;
const PO_MD_PATH = join(COS_DIR, "po.md");

// Inline editorial monogram — accent square with a reversed-out italic serif
// "P", echoing the masthead typography. `currentColor` = --accent, so a single
// CSS rule on .po-mark drives the whole mark and it adapts to dark mode for
// free.
const PO_MARK_SVG = `<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <rect class="po-mark__bg" x="0" y="0" width="32" height="32" rx="3" ry="3"/>
  <text class="po-mark__glyph" x="16" y="23" text-anchor="middle" font-family="'Iowan Old Style','Palatino Linotype',Palatino,Georgia,ui-serif,serif" font-size="23" font-style="italic" font-weight="500">P</text>
</svg>`;

// Tiny markdown → HTML: handles what po.md actually uses (h1/h2, paragraphs,
// `-` bullets, blockquotes, **bold**, *italic*, `code`). No link syntax — bio
// has none. Escape first so nothing inside the file can break out.
const renderBioMarkdown = (md: string): string => {
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/(^|[\s(])_([^_]+)_(?=[\s.,!?)]|$)/g, "$1<em>$2</em>");
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    if (/^-\s+/.test(line)) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^-\s+/, ""))}</li>`);
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
};

let poBioHtmlCache: string | null = null;
const getPoBioHtml = (): string => {
  if (poBioHtmlCache !== null) return poBioHtmlCache;
  try {
    poBioHtmlCache = renderBioMarkdown(readFileSync(PO_MD_PATH, "utf8"));
  } catch {
    poBioHtmlCache = `<p>Po's bio is missing at <code>${escapeHtml(PO_MD_PATH)}</code>.</p>`;
  }
  return poBioHtmlCache;
};

// Meeting prep markdown → HTML. A little richer than renderBioMarkdown —
// prep files use link syntax and fenced code blocks, which the bio does not.
// Still intentionally minimal: no syntax highlighting, no tables, no raw
// HTML pass-through.
const renderPrepMarkdown = (md: string): string => {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];
  let inList = false;
  let inOrdered = false;
  let inCode = false;
  let codeBuf: string[] = [];
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
    if (inOrdered) {
      out.push("</ol>");
      inOrdered = false;
    }
  };
  const inline = (s: string): string =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_m, label, href) =>
          `<a href="${href}" target="_blank" rel="noopener">${label}</a>`,
      );

  for (const line of lines) {
    if (/^```/.test(line)) {
      if (inCode) {
        out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      closeList();
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }
    const ol = /^\d+\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      if (!inOrdered) {
        out.push("<ol>");
        inOrdered = true;
      }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      if (inOrdered) {
        out.push("</ol>");
        inOrdered = false;
      }
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ""))}</li>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push("<hr>");
      continue;
    }
    if (line.trim() === "") {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (inCode) {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
  }
  return out.join("\n");
};

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
@media (min-width: 1100px) {
  body { max-width: 1240px; }
}

/* ----- Layout grid -----
 * Default: single column (mobile + tablet). Grid promotes to 2-col at
 * 1100px, but only when Upcoming has content — .layout--two-col is
 * applied conditionally by the renderer so an empty right rail never
 * takes up half the screen.
 */
.layout { display: block; }
.layout .section { margin-bottom: 40px; }
.layout .section:last-child { margin-bottom: 0; }

@media (min-width: 1100px) {
  .layout--two-col {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr);
    grid-template-areas:
      "review upcoming"
      "fyi    fyi";
    column-gap: 40px;
    row-gap: 56px;
    align-items: start;
  }
  .layout--two-col .section { margin-bottom: 0; }
  .layout--two-col .section--review { grid-area: review; min-width: 0; }
  .layout--two-col .section--upcoming {
    grid-area: upcoming;
    min-width: 0;
    position: sticky;
    top: 24px;
    align-self: start;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    /* Thin scrollbar so the sticky rail doesn't jump when it grows content. */
    scrollbar-width: thin;
    scrollbar-gutter: stable;
  }
  .layout--two-col .section--fyi { grid-area: fyi; min-width: 0; }
}

/* Masthead — serif nameplate, thin hairline rule beneath, refresh meta in mono. */
.masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--rule-strong);
  margin-bottom: 32px;
}
.masthead__brand {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.po-mark {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  line-height: 0;
  color: var(--accent);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.po-mark:hover { opacity: 0.8; }
.po-mark:active { transform: scale(0.96); }
.po-mark:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: 3px;
}
.po-mark svg { display: block; width: 100%; height: 100%; }
.po-mark svg .po-mark__bg { fill: currentColor; }
.po-mark svg .po-mark__glyph { fill: var(--paper); }

/* Po bio dialog — unreset a <dialog>, then paint it in the editorial palette. */
.po-dialog {
  max-width: 640px;
  width: calc(100vw - 32px);
  max-height: 85vh;
  margin: auto;
  padding: 0;
  border: 1px solid var(--rule-strong);
  border-radius: 8px;
  background: var(--paper);
  color: var(--fg);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25), 0 2px 8px rgba(0, 0, 0, 0.1);
  font-family: var(--font-body);
}
.po-dialog::backdrop {
  background: rgba(20, 18, 12, 0.45);
  backdrop-filter: blur(2px);
}
.po-dialog__head {
  position: sticky;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  background: var(--paper);
  border-bottom: 1px solid var(--rule);
  z-index: 1;
}
.po-dialog__title {
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin: 0;
}
.po-dialog__close {
  font-family: inherit;
  font-size: 18px;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid var(--rule-strong);
  background: var(--paper);
  color: var(--muted);
  cursor: pointer;
}
.po-dialog__close:hover { background: var(--rule); color: var(--fg-soft); }
.po-dialog__body {
  padding: 28px 36px 40px;
  overflow-y: auto;
  max-height: calc(85vh - 52px);
  color: var(--fg-soft);
  font-size: 14.5px;
  line-height: 1.65;
}
.po-dialog__body h1 {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 400;
  font-size: 40px;
  line-height: 1;
  letter-spacing: -0.01em;
  color: var(--fg);
  margin: 0 0 24px;
}
.po-dialog__body h2 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 20px;
  line-height: 1.2;
  color: var(--fg);
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--rule);
}
.po-dialog__body h3 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 16px;
  color: var(--fg);
  margin: 20px 0 8px;
}
.po-dialog__body p { margin: 0 0 12px; }
.po-dialog__body ul { margin: 0 0 12px; padding-left: 20px; }
.po-dialog__body li { margin-bottom: 6px; }
.po-dialog__body strong { color: var(--fg); }
.po-dialog__body em { font-style: italic; }
.po-dialog__body code {
  font-family: var(--font-mono);
  font-size: 12.5px;
  padding: 1px 5px;
  background: var(--rule);
  border-radius: 3px;
  color: var(--fg);
}
.po-dialog__body blockquote {
  margin: 16px 0;
  padding: 4px 18px;
  border-left: 3px solid var(--accent);
  color: var(--fg);
  font-family: var(--font-display);
  font-style: italic;
  font-size: 16px;
  line-height: 1.5;
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

/* ----- Upcoming meetings ----- */
.card--upcoming { border-left-color: var(--accent); }
.card--upcoming-pending { border-left-color: var(--amber); }
.card--upcoming-ready { border-left-color: var(--green); }
.card__when {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  font-weight: 600;
  letter-spacing: 0.02em;
  margin-right: 10px;
}
.prep-badge {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--rule-strong);
  color: var(--muted);
  background: var(--paper);
}
.prep-badge--ready { color: var(--green-fg); background: var(--green-bg); border-color: var(--green); }
.prep-badge--pending { color: var(--amber); background: var(--amber-bg); border-color: var(--amber); }
.prep-badge--failed { color: var(--red); background: var(--red-bg); border-color: var(--red); }
.prep-badge--skipped { color: var(--muted); background: var(--paper); border-color: var(--rule-strong); font-style: italic; }
.prep-badge--none { color: var(--muted); background: var(--paper); border-color: var(--rule-strong); }
.prep-badge .prep-icon {
  display: inline-block;
  vertical-align: -2px;
  margin-right: 4px;
  width: 10px;
  height: 10px;
}
.prep-badge--pending .prep-icon {
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: prep-spin 0.9s linear infinite;
}
.prep-badge--skipped .prep-icon::before {
  content: "◷";
  display: block;
  line-height: 10px;
  font-size: 12px;
  margin-top: -2px;
  font-style: normal;
}
@keyframes prep-spin {
  from { transform: rotate(0deg); }
  to   { transform: rotate(360deg); }
}

/* Prep-pending primary button: disabled shell with inline spinner glyph. */
.btn--prep-pending {
  border-color: var(--amber);
  color: var(--amber);
  background: var(--amber-bg);
  cursor: default;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.btn--prep-pending::before {
  content: "";
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: prep-spin 0.9s linear infinite;
}

.card__prep-error {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--red);
  word-break: break-word;
  white-space: pre-wrap;
  line-height: 1.4;
}
.card__prep-skipped-note {
  margin-top: 6px;
  font-style: italic;
  font-size: 12px;
  color: var(--muted);
}

.card--upcoming-failed { border-left-color: var(--red); }
.card--upcoming-skipped { border-left-color: var(--muted-2); }

/* ----- Upcoming: compact glance-widget rows ----- */
.card--upcoming,
.card--upcoming-ready,
.card--upcoming-pending,
.card--upcoming-failed,
.card--upcoming-skipped {
  padding: 10px 12px;
  margin-bottom: 8px;
}
.card--upcoming .card__subject,
.card--upcoming-ready .card__subject,
.card--upcoming-pending .card__subject,
.card--upcoming-failed .card__subject,
.card--upcoming-skipped .card__subject {
  font-size: 13.5px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  word-break: normal;
}
.card--upcoming .card__meta,
.card--upcoming-ready .card__meta,
.card--upcoming-pending .card__meta,
.card--upcoming-failed .card__meta,
.card--upcoming-skipped .card__meta {
  margin-top: 6px;
  gap: 10px;
  font-size: 10.5px;
}

/* Overflow menu: single-secondary-action dropdown that needs no JS. */
.overflow { position: relative; }
.overflow > summary {
  list-style: none;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 26px;
  border: 1px solid var(--rule-strong);
  border-radius: 4px;
  background: var(--paper);
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  user-select: none;
}
.overflow > summary::-webkit-details-marker { display: none; }
.overflow > summary:hover { background: var(--rule); color: var(--fg-soft); }
.overflow[open] > summary { background: var(--rule); color: var(--fg-soft); }
.overflow__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 10;
  min-width: 140px;
  padding: 6px;
  background: var(--paper);
  border: 1px solid var(--rule-strong);
  border-radius: 6px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.overflow__menu a, .overflow__menu button {
  text-align: left;
  white-space: nowrap;
}

/* Empty-state card: compact Po signoff. Same visual weight as a single
 * meeting row so the right rail doesn't balloon when the calendar is clear. */
.card--upcoming-empty {
  padding: 12px 14px;
  margin-bottom: 8px;
  background: var(--paper);
  border: 1px solid var(--rule);
  border-left: 3px solid var(--muted-2);
  border-radius: 6px;
  box-shadow: var(--shadow);
}
.card--upcoming-empty__quip {
  font-family: var(--font-display);
  font-size: 14px;
  line-height: 1.4;
  color: var(--fg-soft);
  font-style: italic;
  letter-spacing: -0.003em;
}
.card--upcoming-empty__sig {
  margin-top: 8px;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-style: italic;
  letter-spacing: 0.04em;
  color: var(--muted);
}

.upcoming-more {
  margin-top: 4px;
  padding: 8px 12px;
  background: transparent;
  border: 1px dashed var(--rule-strong);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  cursor: pointer;
}
.upcoming-more summary {
  list-style: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 8px;
  letter-spacing: 0.04em;
}
.upcoming-more summary::-webkit-details-marker { display: none; }
.upcoming-more summary::before {
  content: "▸";
  font-size: 9px;
  transition: transform 0.12s ease-out;
}
.upcoming-more[open] summary::before { transform: rotate(90deg); }
.upcoming-more summary .label { color: var(--fg-soft); text-transform: uppercase; }
.upcoming-more[open] { padding-bottom: 4px; }
.upcoming-more[open] .upcoming-more__body { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--rule); }
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
  if (item.kind === "plan-review") return "card--pr";
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
    case "plan-review": {
      // "Review plan" spawns plannotator-annotate on the plan markdown in a
      // new Terminal; on exit the wrapper prompts approve/feedback/skip and
      // persists the decision back to the plans row. Approve / Dismiss on
      // the row itself are shortcuts for users confident without reading.
      const review = `<form method="post" action="/plans/${id}/review-plannotator">${rtn}<button class="btn btn--primary">Review plan</button></form>`;
      const approve = btn(
        `/plans/${id}/approve`,
        "approve",
        returnTo,
        "btn btn--promote",
      );
      const dismiss = btn(
        `/plans/${id}/dismiss`,
        "dismiss",
        returnTo,
        "btn btn--muted",
      );
      return review + approve + dismiss;
    }
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

type PrepVariant =
  | "prep-ready"
  | "prep-running"
  | "prep-failed"
  | "no-prep-needed"
  | "no-prep";

const PREP_VARIANT_UI: Record<
  PrepVariant,
  { badgeLabel: string; badgeCls: string; accent: string; icon: string }
> = {
  "prep-ready": {
    badgeLabel: "prep ready",
    badgeCls: "prep-badge prep-badge--ready",
    accent: "card--upcoming-ready",
    icon: "",
  },
  "prep-running": {
    badgeLabel: "prep running",
    badgeCls: "prep-badge prep-badge--pending",
    accent: "card--upcoming-pending",
    icon: '<span class="prep-icon" aria-hidden="true"></span>',
  },
  "prep-failed": {
    badgeLabel: "prep failed",
    badgeCls: "prep-badge prep-badge--failed",
    accent: "card--upcoming-failed",
    icon: "",
  },
  "no-prep-needed": {
    badgeLabel: "no prep needed",
    badgeCls: "prep-badge prep-badge--skipped",
    accent: "card--upcoming-skipped",
    icon: '<span class="prep-icon" aria-hidden="true"></span>',
  },
  "no-prep": {
    badgeLabel: "no prep",
    badgeCls: "prep-badge prep-badge--none",
    accent: "card--upcoming",
    icon: "",
  },
};

const coercePrepVariant = (v: string): PrepVariant => {
  switch (v) {
    case "prep-ready":
    case "prep-running":
    case "prep-failed":
    case "no-prep-needed":
    case "no-prep":
      return v;
    // Legacy alias from before wi-63 — collapse to the new running state.
    case "prep-pending":
      return "prep-running";
    default:
      return "no-prep";
  }
};

// Builds the one-primary-action CTA for the row. The glanceable widget
// shows exactly one CTA per state:
//   - ready         → Open prep (new tab, rendered markdown)
//   - running       → disabled "Prep running…" with spinner
//   - failed        → Retry (POST prep-now)
//   - no-prep-needed → none (labeled "Solo meeting" inline instead)
//   - no-prep       → Prep now (POST prep-now)
const renderPrepPrimary = (
  variant: PrepVariant,
  eventId: string,
  returnTo: string,
): string => {
  const id = encodeURIComponent(eventId);
  switch (variant) {
    case "prep-ready":
      return `<a class="btn btn--primary" href="/meetings/${id}/prep" target="_blank" rel="noopener">Open prep</a>`;
    case "prep-running":
      return `<button class="btn btn--prep-pending" disabled aria-disabled="true">Prep running…</button>`;
    case "prep-failed":
      return `<form method="post" action="/meetings/${id}/prep-now">${hiddenReturn(returnTo)}<button class="btn btn--primary">Retry</button></form>`;
    case "no-prep-needed":
      return "";
    case "no-prep":
      return `<form method="post" action="/meetings/${id}/prep-now">${hiddenReturn(returnTo)}<button class="btn btn--primary">Prep now</button></form>`;
  }
};

const renderUpcomingCard = (item: InboxItem, returnTo: string): string => {
  const meta = item.meta ?? {};
  const relative = String(meta.relative ?? "");
  const absolute = String(meta.absolute ?? "");
  const attendees = Number(meta.attendees ?? 0);
  const variant = coercePrepVariant(String(meta.prepStatus ?? "no-prep"));
  const prepPath =
    meta.prepPath === null || meta.prepPath === undefined
      ? ""
      : String(meta.prepPath);
  const hangoutLink =
    meta.hangoutLink === null || meta.hangoutLink === undefined
      ? ""
      : String(meta.hangoutLink);
  const prepError =
    meta.prepError === null || meta.prepError === undefined
      ? ""
      : String(meta.prepError);

  const ui = PREP_VARIANT_UI[variant];
  const primaryBtn = renderPrepPrimary(variant, item.id, returnTo);

  // Overflow menu holds the secondary "Open in default app" and "Join meeting"
  // actions so the inline row stays a one-CTA glance.
  const overflowItems: string[] = [];
  if (hangoutLink) {
    overflowItems.push(
      `<a class="btn btn--muted" href="${escapeHtml(hangoutLink)}" target="_blank" rel="noopener">Join meeting</a>`,
    );
  }
  if (variant === "prep-ready" && prepPath) {
    overflowItems.push(
      `<form method="post" action="/meetings/${encodeURIComponent(item.id)}/open-prep">${hiddenReturn(returnTo)}<input type="hidden" name="prepPath" value="${escapeHtml(prepPath)}"><button class="btn btn--muted">Open in default app</button></form>`,
    );
  }
  const overflowMenu = overflowItems.length
    ? `<details class="overflow"><summary title="more">⋯</summary><div class="overflow__menu">${overflowItems.join("")}</div></details>`
    : "";
  const attendeeLabel =
    attendees === 1 ? "1 attendee" : `${attendees} attendees`;

  const errorLine =
    variant === "prep-failed" && prepError
      ? `<div class="card__prep-error">${escapeHtml(prepError)}</div>`
      : "";
  const skippedNote =
    variant === "no-prep-needed"
      ? `<div class="card__prep-skipped-note">Solo meeting — no prep generated.</div>`
      : "";

  return `
<article class="card ${ui.accent}" id="row-${escapeHtml(item.key)}">
  <div class="card__head">
    <div class="card__body">
      <div class="card__subject"><span class="card__when">${escapeHtml(relative)}</span>${escapeHtml(item.subject)}</div>
      <div class="card__meta">
        <span class="${ui.badgeCls}">${ui.icon}${escapeHtml(ui.badgeLabel)}</span>
        <span>${escapeHtml(absolute)}</span>
        <span>${escapeHtml(attendeeLabel)}</span>
      </div>
      ${errorLine}
      ${skippedNote}
    </div>
    <div class="actions">${primaryBtn}${overflowMenu}</div>
  </div>
</article>`;
};

const UPCOMING_VISIBLE_LIMIT = 5;

const renderUpcomingEmptyCard = (item: InboxItem): string => `
<article class="card card--upcoming-empty" id="row-${escapeHtml(item.key)}">
  <div class="card--upcoming-empty__quip">${escapeHtml(item.subject)}</div>
  <div class="card--upcoming-empty__sig">— Po</div>
</article>`;

const renderUpcomingSection = (items: InboxItem[]): string => {
  if (!items.length) return "";
  const isEmptyState = items.length === 1 && items[0].kind === "upcoming-empty";
  const countLabel = isEmptyState
    ? "clear"
    : `${items.length} ${items.length === 1 ? "meeting" : "meetings"}`;
  const head = `<div class="section__head">
      <div>
        <h2 class="section__title">${SECTION_TITLES.upcoming}</h2>
      </div>
      <div class="section__head-actions">
        <span class="section__count">${countLabel}</span>
      </div>
    </div>`;
  if (isEmptyState) {
    return `<section class="section section--upcoming" id="section-upcoming">${head}${renderUpcomingEmptyCard(items[0])}</section>`;
  }
  // Compact mode: first N visible, rest behind a "Show all" disclosure so the
  // sticky rail stays glanceable even when the full calendar has more.
  const visibleItems = items.slice(0, UPCOMING_VISIBLE_LIMIT);
  const hiddenItems = items.slice(UPCOMING_VISIBLE_LIMIT);
  const visibleBody = visibleItems
    .map((it, i) =>
      renderUpcomingCard(it, nextAnchor(items, i, "section-upcoming")),
    )
    .join("");
  const hiddenBody = hiddenItems.length
    ? `<details class="upcoming-more"><summary><span class="label">Show all</span> <span class="n">+${hiddenItems.length}</span></summary><div class="upcoming-more__body">${hiddenItems
        .map((it, i) =>
          renderUpcomingCard(
            it,
            nextAnchor(items, i + UPCOMING_VISIBLE_LIMIT, "section-upcoming"),
          ),
        )
        .join("")}</div></details>`
    : "";
  return `<section class="section section--upcoming" id="section-upcoming">${head}${visibleBody}${hiddenBody}</section>`;
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
  var dlg = document.getElementById('po-dialog');
  // Use document-level delegation because the masthead lives inside #inbox-main
  // and gets innerHTML-replaced every 5s by the refresh loop below — any
  // listener bound to the button directly would evaporate on first poll.
  if (dlg) {
    document.addEventListener('click', function(e){
      var t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest('#po-mark-btn')) {
        e.preventDefault();
        if (typeof dlg.showModal === 'function') dlg.showModal();
        else dlg.setAttribute('open', '');
        return;
      }
      if (t.closest('.po-dialog__close')) { dlg.close(); return; }
    });
    dlg.addEventListener('click', function(e){
      if (e.target === dlg) dlg.close();
    });
  }

  if (typeof fetch !== 'function' || typeof DOMParser !== 'function') return;
  var POLL_MS = 5000;
  var isTyping = function(){
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA'));
  };
  var refresh = function(){
    if (isTyping()) return;
    if (document.hidden) return;
    if (dlg && dlg.open) return;
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
    total === 0 &&
    dashboard.recentWins.length === 0 &&
    dashboard.upcoming.length === 0
      ? `<div class="zero-state">Inbox empty. Po has nothing for you.<span class="sig">— Po</span></div>`
      : "";
  const reviewSection = renderReviewSection(dashboard.review);
  const upcomingSection = renderUpcomingSection(dashboard.upcoming);
  const fyiSection = renderFyiSection(dashboard);
  // Two-col grid only kicks in when Upcoming has something to show — with no
  // meetings there's no right rail to render, and the layout collapses to a
  // Review-above-FYI stack.
  const layoutCls = dashboard.upcoming.length
    ? "layout layout--two-col"
    : "layout";
  const body =
    zeroState ||
    `<div class="${layoutCls}">${reviewSection}${upcomingSection}${fyiSection}</div>`;
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
  <div class="masthead__brand">
    <button type="button" id="po-mark-btn" class="po-mark" aria-label="About Po" aria-haspopup="dialog" aria-controls="po-dialog">${PO_MARK_SVG}</button>
    <h1>Inbox${total ? `<span class="count">${total}</span>` : ""}</h1>
  </div>
  <div class="meta">refreshed ${now} · polls every 5s</div>
</header>
${renderTickBanner(tick)}
${body}
</div>
<dialog id="po-dialog" class="po-dialog" aria-labelledby="po-dialog-title">
  <div class="po-dialog__head">
    <h2 id="po-dialog-title" class="po-dialog__title">About Po</h2>
    <button type="button" class="po-dialog__close" aria-label="Close">×</button>
  </div>
  <div class="po-dialog__body">${getPoBioHtml()}</div>
</dialog>
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

// Renders the prep markdown for an event id as a standalone HTML page. The
// markdown filename (<yyyy-mm-dd>-<slug>.md) is computed from the live
// UpcomingMeeting row so users can't read arbitrary paths off MEETINGS_DIR
// by guessing file names.
const renderPrepPage = (eventId: string): { code: number; html: string } => {
  const meeting = findUpcomingMeetingById(eventId);
  if (!meeting) {
    return {
      code: 404,
      html: `<!doctype html><meta charset=utf-8><title>Prep not found</title><p>No meeting with id <code>${escapeHtml(eventId)}</code> in the current 8h window.</p>`,
    };
  }
  const path = `${MEETINGS_DIR}/${basename(meeting.prepSlug)}.md`;
  if (!existsSync(path)) {
    return {
      code: 404,
      html: `<!doctype html><meta charset=utf-8><title>Prep not found</title><p>No prep file at <code>${escapeHtml(path)}</code>.</p>`,
    };
  }
  const md = readFileSync(path, "utf8");
  const body = renderPrepMarkdown(md);
  return {
    code: 200,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meeting.summary)} — prep</title>
<style>${styles}
/* Prep-view overrides: give the prose a readable measure and editorial
 * heading rhythm. The base styles assume a dashboard density that would
 * feel cramped as long-form content. */
body { max-width: 720px; padding-top: 40px; padding-bottom: 120px; }
.prep-view { color: var(--fg-soft); font-size: 15px; line-height: 1.7; }
.prep-view h1 {
  font-family: var(--font-display);
  font-style: italic;
  font-weight: 400;
  font-size: 40px;
  line-height: 1.1;
  color: var(--fg);
  margin: 0 0 8px;
}
.prep-view h2 {
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 22px;
  color: var(--fg);
  margin: 28px 0 10px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--rule);
}
.prep-view h3 { font-family: var(--font-display); font-weight: 600; font-size: 17px; color: var(--fg); margin: 22px 0 8px; }
.prep-view p { margin: 0 0 12px; }
.prep-view ul, .prep-view ol { margin: 0 0 14px; padding-left: 22px; }
.prep-view li { margin-bottom: 6px; }
.prep-view strong { color: var(--fg); }
.prep-view code {
  font-family: var(--font-mono);
  font-size: 13px;
  padding: 1px 5px;
  background: var(--rule);
  border-radius: 3px;
  color: var(--fg);
}
.prep-view pre {
  font-family: var(--font-mono);
  font-size: 12.5px;
  background: var(--rule);
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
  line-height: 1.5;
}
.prep-view pre code { padding: 0; background: transparent; font-size: inherit; }
.prep-view blockquote {
  margin: 16px 0;
  padding: 4px 18px;
  border-left: 3px solid var(--accent);
  color: var(--fg);
  font-family: var(--font-display);
  font-style: italic;
  font-size: 16px;
  line-height: 1.5;
}
.prep-view hr { border: 0; border-top: 1px solid var(--rule-strong); margin: 32px 0; }
.prep-view a { color: var(--accent); }
.prep-back {
  display: inline-block;
  margin-bottom: 24px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  text-decoration: none;
}
.prep-back:hover { color: var(--accent); }
.prep-meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  letter-spacing: 0.02em;
  margin: 0 0 28px;
}
</style>
</head>
<body>
<a class="prep-back" href="/">← Inbox</a>
<p class="prep-meta">${escapeHtml(path)}</p>
<article class="prep-view">${body}</article>
</body>
</html>`,
  };
};

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
    const prepGet =
      method === "GET" && path.match(/^\/meetings\/([^/]+)\/prep$/);
    if (prepGet) {
      const eventId = decodeURIComponent(prepGet[1]);
      const page = renderPrepPage(eventId);
      res.writeHead(page.code, { "Content-Type": "text/html; charset=utf-8" });
      res.end(page.html);
      return;
    }
    const planGet = method === "GET" && path.match(/^\/plans\/([^/]+)$/);
    if (planGet) {
      const planId = decodeURIComponent(planGet[1]);
      const p = plans.get(planId);
      if (!p) return sendText(res, 404, `plan not found: ${planId}`);
      let md = "";
      try {
        md = readFileSync(p.path, "utf8");
      } catch (e: any) {
        return sendText(res, 500, `could not read plan file: ${e.message}`);
      }
      res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8" });
      res.end(md);
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
        /^\/plans\/([^/]+)\/approve$/,
        (m) => approvePlan(decodeURIComponent(m[1])),
      ],
      [
        /^\/plans\/([^/]+)\/dismiss$/,
        (m) => dismissPlan(decodeURIComponent(m[1])),
      ],
      [
        /^\/plans\/([^/]+)\/review-plannotator$/,
        (m) => reviewPlanInPlannotator(decodeURIComponent(m[1])),
      ],
      [
        /^\/plans\/([^/]+)\/feedback$/,
        (m) =>
          submitPlanFeedback(decodeURIComponent(m[1]), form.feedback ?? ""),
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
      [
        /^\/meetings\/([^/]+)\/prep-now$/,
        (m) => prepMeetingNow(decodeURIComponent(m[1])),
      ],
      [
        /^\/meetings\/([^/]+)\/open-prep$/,
        () => openPrepFile(form.prepPath ?? ""),
      ],
      [
        /^\/meetings\/reload$/,
        async () => {
          invalidateUpcomingCache();
          return { ok: true as const, message: "invalidated upcoming cache" };
        },
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
  // Orphaned runs from the previous instance become "failed (server
  // restarted)" so the dashboard doesn't paint a perma-yellow badge.
  const orphans = reconcileOrphanedPrepRuns();
  if (orphans)
    console.log(chalk.gray(`reconciled ${orphans} orphaned prep run(s)`));
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
