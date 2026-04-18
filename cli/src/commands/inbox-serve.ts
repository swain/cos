import { createServer, IncomingMessage, ServerResponse } from "node:http";
import chalk from "chalk";
import { getDb } from "../db.js";
import {
  collectInbox,
  groupByBand,
  getCronTickStatus,
  type CronTickStatus,
} from "../inbox/data.js";
import {
  ackNotification,
  approveWorkItem,
  snoozeWorkItem,
  suppressSignal,
  markAllFyiRead,
} from "../inbox/actions.js";
import type { InboxItem } from "../inbox/types.js";

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
  const then = new Date(iso).getTime();
  const now = Date.now();
  const sec = Math.max(0, Math.round((now - then) / 1000));
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
  max-width: 900px;
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
.item {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 8px;
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.item.urgent { border-color: var(--red); background: var(--red-bg); }
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
.actions { display: flex; gap: 6px; flex-shrink: 0; }
.actions form { margin: 0; }
.actions button {
  background: transparent;
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 4px 8px;
  font-size: 12px;
  cursor: pointer;
  font-family: inherit;
}
.actions button:hover { background: var(--border); }
.actions button.primary { border-color: var(--accent); color: var(--accent); }
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

const renderActions = (item: InboxItem): string => {
  if (item.kind === "notification") {
    return `<form method="post" action="/notifications/${encodeURIComponent(item.id)}/ack"><button>ack</button></form>`;
  }
  if (item.kind === "work-item") {
    return `
      <form method="post" action="/work-items/${encodeURIComponent(item.id)}/approve"><button class="primary">approve &amp; dispatch</button></form>
      <form method="post" action="/work-items/${encodeURIComponent(item.id)}/snooze"><button>snooze</button></form>`;
  }
  if (item.kind === "signal") {
    return `<form method="post" action="/signals/${encodeURIComponent(item.id)}/suppress"><button class="danger">suppress</button></form>`;
  }
  // session — no action, informational
  return "";
};

const renderItem = (item: InboxItem): string => {
  const urgentClass = item.urgency === "urgent" ? " urgent" : "";
  const related = renderRelated(item.related_ids);
  return `
<div class="item${urgentClass}">
  <div class="body">
    <div class="subject">${escapeHtml(item.subject)}</div>
    ${item.body ? `<div class="text">${escapeHtml(item.body)}</div>` : ""}
    <div class="meta">
      <span class="badge ${escapeHtml(item.urgency)}">${escapeHtml(item.kind)}</span>
      <span>${relTime(item.created_at)} ago</span>
      ${related ? `<span>${related}</span>` : ""}
      <span>${escapeHtml(item.id)}</span>
    </div>
  </div>
  <div class="actions">${renderActions(item)}</div>
</div>`;
};

const renderSection = (
  id: "needs-decision" | "fyi" | "digest",
  title: string,
  items: InboxItem[],
  emptyText: string,
  showMarkAll = false,
): string => {
  if (!items.length) {
    return `<section class="section ${id}"><h2>${title}</h2><div class="empty">${emptyText}</div></section>`;
  }
  const body = items.map(renderItem).join("");
  const bulkAction = showMarkAll
    ? `<div class="bulk"><form method="post" action="/inbox/mark-all-fyi-read"><button>mark all FYI read</button></form></div>`
    : "";
  return `<section class="section ${id}"><h2>${title} (${items.length})</h2>${body}${bulkAction}</section>`;
};

const renderTickBanner = (tick: CronTickStatus | null): string => {
  if (!tick) return "";
  const stale = tick.stale ? " stale" : "";
  const staleSuffix = tick.stale
    ? ` · looks stale — last completed ${escapeHtml(tick.last_completed_at ?? "never")}`
    : "";
  return `<div class="tick-banner${stale}">⟳ Cron tick in progress (started ${tick.age_minutes}m ago)${staleSuffix}<span class="id">${escapeHtml(tick.id)}</span></div>`;
};

const renderPage = (
  items: InboxItem[],
  tick: CronTickStatus | null,
): string => {
  const bands = groupByBand(items);
  const total = items.length;
  const now = new Date().toLocaleTimeString();
  const zeroState =
    total === 0
      ? `<div class="zero-state">Inbox empty. Po has nothing for you.<span class="sig">— Po</span></div>`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3">
<title>Inbox${total ? ` (${total})` : ""}</title>
<style>${styles}</style>
</head>
<body>
<h1>Inbox${total ? ` · ${total}` : ""}</h1>
<div class="subtle">Refreshed ${now} · polls every 3s</div>
${renderTickBanner(tick)}
${zeroState}
${renderSection("needs-decision", "Needs decision", bands.decision, "Nothing blocking.")}
${renderSection("fyi", "FYI", bands.fyi, "No FYI items.", bands.fyi.length > 0)}
${renderSection("digest", "Digest", bands.digest, "Empty.")}
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

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";
  const [pathRaw] = url.split("?");
  const path = decodeURI(pathRaw);

  try {
    if (method === "GET" && path === "/") {
      sendHtml(res, renderPage(collectInbox(), getCronTickStatus()));
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

    await readBody(req);

    const notifAck = path.match(/^\/notifications\/([^/]+)\/ack$/);
    if (notifAck) {
      const r = await ackNotification(decodeURIComponent(notifAck[1]));
      return r.ok ? sendRedirect(res) : sendText(res, 500, r.message);
    }
    const wiApprove = path.match(/^\/work-items\/([^/]+)\/approve$/);
    if (wiApprove) {
      const r = await approveWorkItem(decodeURIComponent(wiApprove[1]));
      return r.ok ? sendRedirect(res) : sendText(res, 500, r.message);
    }
    const wiSnooze = path.match(/^\/work-items\/([^/]+)\/snooze$/);
    if (wiSnooze) {
      const r = await snoozeWorkItem(decodeURIComponent(wiSnooze[1]));
      return r.ok ? sendRedirect(res) : sendText(res, 500, r.message);
    }
    const sigSup = path.match(/^\/signals\/([^/]+)\/suppress$/);
    if (sigSup) {
      const r = await suppressSignal(decodeURIComponent(sigSup[1]));
      return r.ok ? sendRedirect(res) : sendText(res, 500, r.message);
    }
    const sessAck = path.match(/^\/sessions\/([^/]+)\/ack$/);
    if (sessAck) {
      const id = decodeURIComponent(sessAck[1]);
      const result = getDb()
        .prepare("UPDATE sessions SET acked_at = datetime('now') WHERE id = ?")
        .run(id);
      if (result.changes === 0) return sendText(res, 404, "not found");
      return sendRedirect(res);
    }
    if (path === "/inbox/mark-all-fyi-read") {
      const r = await markAllFyiRead(collectInbox());
      return r.ok ? sendRedirect(res) : sendText(res, 500, r.message);
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
