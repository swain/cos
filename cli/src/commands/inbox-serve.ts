import { createServer, IncomingMessage, ServerResponse } from "node:http";
import chalk from "chalk";
import { getDb } from "../db.js";
import {
  collectDashboard,
  getCronTickStatus,
  type CronTickStatus,
} from "../inbox/data.js";
import {
  ackNotification,
  approveWorkItem,
  abandonWorkItem,
  archiveWorkItem,
  bumpWorkItem,
  dismissSession,
  dispatchWorkItem,
  enqueueInboxResponse,
  killSession,
  markAllFyiRead,
  markPrReviewed,
  peekSession,
  retrySession,
  retryWorkItem,
  snoozeWorkItem,
  suppressSignal,
  viewFailureLog,
  type ActionResult,
} from "../inbox/actions.js";
import {
  SECTION_ORDER,
  SECTION_TITLES,
  type InboxDashboard,
  type InboxItem,
  type Section,
} from "../inbox/types.js";

const HOST = "127.0.0.1";
const PORT = 4411;

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

const styles = `
:root {
  --bg: #0f1115;
  --fg: #e8e8ea;
  --muted: #8a8d95;
  --border: #23262d;
  --panel: #15181f;
  --red: #e0534b;
  --red-bg: #3a1b19;
  --amber: #d7a34b;
  --green: #4cae6b;
  --accent: #7eb3ff;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  padding: 24px 16px 64px;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  max-width: 980px;
}
h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
.subtle { color: var(--muted); font-size: 12px; margin-bottom: 24px; }
.section { margin-bottom: 28px; }
.section h2 {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  font-weight: 600;
  margin: 0 0 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.section.needs-decision h2 { color: var(--red); border-color: var(--red); }
.section.active h2 { color: var(--green); border-color: var(--green); }
.section.anomalies h2 { color: var(--amber); border-color: var(--amber); }
.item {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
}
.item.urgent { border-color: var(--red); background: var(--red-bg); }
.item .row { display: flex; gap: 12px; align-items: flex-start; }
.item .body { flex: 1; min-width: 0; }
.item .subject { font-weight: 600; word-break: break-word; }
.item .text {
  color: var(--muted);
  margin-top: 2px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.item .meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--muted);
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.item .meta a { color: var(--accent); text-decoration: none; }
.item .meta a:hover { text-decoration: underline; }
.badge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--border);
  color: var(--muted);
}
.badge.urgent { background: var(--red); color: #fff; }
.actions { display: flex; gap: 6px; flex-shrink: 0; flex-wrap: wrap; align-items: flex-start; }
.actions form { margin: 0; }
.actions button, .actions a.btn {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
  text-decoration: none;
  display: inline-block;
}
.actions button:hover, .actions a.btn:hover { background: var(--border); }
.actions button.primary, .actions a.btn.primary { border-color: var(--accent); color: var(--accent); }
.actions button.danger { border-color: var(--red); color: var(--red); }
.empty { color: var(--muted); font-style: italic; padding: 8px 0; }
.zero-state { color: var(--muted); padding: 24px 0; text-align: center; }
.zero-state .sig { display: block; margin-top: 12px; font-size: 12px; }
.bulk { margin-top: 8px; }
.tick-banner {
  background: var(--panel);
  border: 1px solid var(--border);
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 16px;
  font-size: 12px;
  color: var(--fg);
}
.tick-banner.stale { border-left-color: var(--red); color: var(--red); }
.tick-banner .id { color: var(--muted); margin-left: 8px; }
.nl-form {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}
.nl-form input[type=text] {
  flex: 1;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  font-family: inherit;
}
.nl-form button {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 4px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
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
  cls = "",
): string =>
  `<form method="post" action="${action}">${hiddenReturn(returnTo)}<button class="${cls}">${label}</button></form>`;

const renderActions = (item: InboxItem, returnTo: string): string => {
  const id = encodeURIComponent(item.id);
  const key = encodeURIComponent(item.key);
  switch (item.kind) {
    case "notification":
      return btn(`/notifications/${id}/ack`, "ack", returnTo);
    case "work-item":
      return (
        btn(
          `/work-items/${id}/approve`,
          "approve &amp; dispatch",
          returnTo,
          "primary",
        ) + btn(`/work-items/${id}/snooze`, "snooze", returnTo)
      );
    case "signal":
      return btn(`/signals/${id}/suppress`, "suppress", returnTo, "danger");
    case "session":
      return (
        btn(`/sessions/${id}/retry`, "retry", returnTo, "primary") +
        btn(`/sessions/${id}/kill`, "kill", returnTo, "danger") +
        btn(`/sessions/${id}/dismiss`, "dismiss", returnTo)
      );
    case "worker":
      return (
        btn(`/sessions/${id}/peek`, "peek", returnTo) +
        btn(`/sessions/${id}/kill`, "kill", returnTo, "danger")
      );
    case "queue-item":
      return (
        btn(`/work-items/${id}/dispatch`, "dispatch now", returnTo, "primary") +
        btn(`/work-items/${id}/bump`, "bump", returnTo) +
        btn(`/work-items/${id}/archive`, "archive", returnTo, "danger")
      );
    case "pr-review": {
      const pr = item.related_ids.find(isHttpUrl);
      const openBtn = pr
        ? `<a class="btn primary" href="${escapeHtml(pr)}" target="_blank" rel="noopener">open in github</a>`
        : "";
      return (
        openBtn +
        btn(`/work-items/${id}/pr-reviewed`, "mark reviewed", returnTo) +
        `<form method="post" action="/inbox/rows/${key}/respond" style="display:inline">
          ${hiddenReturn(returnTo)}
          <input type="hidden" name="text" value="dispatch fix worker for this PR">
          <button>dispatch fix worker</button>
         </form>`
      );
    }
    case "blocked-item":
      return (
        btn(`/work-items/${id}/retry`, "retry", returnTo, "primary") +
        btn(`/work-items/${id}/failure-log`, "view log", returnTo) +
        btn(`/work-items/${id}/abandon`, "abandon", returnTo, "danger")
      );
    case "recent-win":
      return btn(`/work-items/${id}/pr-reviewed`, "dismiss", returnTo);
  }
};

const renderItem = (item: InboxItem, returnTo: string): string => {
  const urgentClass = item.urgency === "urgent" ? " urgent" : "";
  const related = renderRelated(item.related_ids);
  const metaExtras = item.meta
    ? Object.entries(item.meta)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(
          ([k, v]) => `<span>${escapeHtml(k)}=${escapeHtml(String(v))}</span>`,
        )
        .join("")
    : "";
  return `
<div class="item${urgentClass}" id="row-${escapeHtml(item.key)}">
  <div class="row">
    <div class="body">
      <div class="subject">${escapeHtml(item.subject)}</div>
      ${item.body ? `<div class="text">${escapeHtml(item.body)}</div>` : ""}
      <div class="meta">
        <span class="badge ${escapeHtml(item.urgency)}">${escapeHtml(item.kind)}</span>
        <span>${relTime(item.created_at)} ago</span>
        ${related ? `<span>${related}</span>` : ""}
        ${metaExtras}
        <span>${escapeHtml(item.displayLabel ?? item.id)}</span>
      </div>
    </div>
    <div class="actions">${renderActions(item, returnTo)}</div>
  </div>
  <form class="nl-form" method="post" action="/inbox/rows/${encodeURIComponent(item.key)}/respond">
    ${hiddenReturn(returnTo)}
    <input type="text" name="text" placeholder="reply in plain English — enqueues a work item for Po">
    <button>send</button>
  </form>
</div>`;
};

const SECTION_CLASS: Record<Section, string> = {
  needsDecision: "needs-decision",
  active: "active",
  queue: "queue",
  recentWins: "recent-wins",
  anomalies: "anomalies",
  fyi: "fyi",
  digest: "digest",
};

const EMPTY_HINTS: Record<Section, string> = {
  needsDecision: "Nothing blocking.",
  active: "No workers running.",
  queue: "Queue is empty.",
  recentWins: "No wins in the last 24h.",
  anomalies: "No stale or failed sessions.",
  fyi: "No FYI items.",
  digest: "Empty.",
};

const renderSection = (
  section: Section,
  items: InboxItem[],
  extraBulk = "",
): string => {
  const title = SECTION_TITLES[section];
  const cls = SECTION_CLASS[section];
  const sectionId = `section-${section}`;
  if (!items.length) {
    return `<section class="section ${cls}" id="${sectionId}"><h2>${title}</h2><div class="empty">${EMPTY_HINTS[section]}</div></section>`;
  }
  const nextAnchor = (i: number): string =>
    i + 1 < items.length
      ? `/#row-${encodeURIComponent(items[i + 1].key)}`
      : `/#${sectionId}`;
  const body = items.map((it, i) => renderItem(it, nextAnchor(i))).join("");
  return `<section class="section ${cls}" id="${sectionId}"><h2>${title} (${items.length})</h2>${body}${extraBulk}</section>`;
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
  const total = SECTION_ORDER.reduce((sum, s) => sum + dashboard[s].length, 0);
  const now = new Date().toLocaleTimeString();
  const zeroState =
    total === 0
      ? `<div class="zero-state">Inbox empty. Po has nothing for you.<span class="sig">— Po</span></div>`
      : "";
  const fyiBulk =
    dashboard.fyi.length + dashboard.anomalies.length > 0
      ? `<div class="bulk"><form method="post" action="/inbox/mark-all-fyi-read">${hiddenReturn("/#section-fyi")}<button>mark all FYI + anomalies read</button></form></div>`
      : "";
  const sections = SECTION_ORDER.map((s) =>
    renderSection(s, dashboard[s], s === "fyi" ? fyiBulk : ""),
  ).join("\n");
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
<h1>Inbox${total ? ` · ${total}` : ""}</h1>
<div class="subtle">Refreshed ${now} · polls every 5s</div>
${renderTickBanner(tick)}
${zeroState}
${sections}
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
