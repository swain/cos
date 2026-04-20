import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { spawn } from "node:child_process";
import {
  collectDashboard,
  getCronTickStatus,
  type CronTickStatus,
} from "./data.js";
import {
  abandonWorkItem,
  acceptIdea,
  ackNotification,
  approveWorkItem,
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
} from "./actions.js";
import {
  SECTION_ORDER,
  SECTION_TITLES,
  flattenDashboard,
  type InboxDashboard,
  type InboxItem,
  type Section,
} from "./types.js";

const REFRESH_MS = 3000;

const URGENCY_COLOR: Record<InboxItem["urgency"], string | undefined> = {
  urgent: "red",
  normal: undefined,
  digest: "gray",
};

const SECTION_COLOR: Record<Section, string | undefined> = {
  review: "red",
  fyi: "gray",
};

const fmtTime = (iso: string): string => {
  const t = new Date(iso + (iso.endsWith("Z") ? "" : "Z")).getTime();
  if (Number.isNaN(t)) return iso;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return "just now";
  const sec = Math.floor(ageMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return iso.slice(0, 10);
};

const fmtClock = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

const looksLikeUrl = (s: string) => /^https?:\/\//.test(s);

const openInBrowser = (url: string) => {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
};

type RenderedSection = {
  section: Section;
  items: InboxItem[];
};

const buildSections = (dashboard: InboxDashboard): RenderedSection[] =>
  SECTION_ORDER.map((section) => ({
    section,
    items: dashboard[section],
  }));

const ItemRow: React.FC<{ item: InboxItem; focused: boolean }> = ({
  item,
  focused,
}) => {
  const cursor = focused ? "▸ " : "  ";
  const tag = `[${item.urgency}]`;
  const time = fmtTime(item.created_at);
  const color = URGENCY_COLOR[item.urgency];
  return (
    <Box flexDirection="column">
      <Text inverse={focused}>
        <Text color={color}>{cursor}</Text>
        <Text color={color}>{tag.padEnd(9)}</Text>
        <Text color={color}>{item.subject}</Text>
        <Text color="gray"> {time}</Text>
      </Text>
      {focused && item.body ? (
        <Text color="gray"> {item.body.split("\n")[0].slice(0, 200)}</Text>
      ) : null}
    </Box>
  );
};

const hintsFor = (item: InboxItem | null): string[] => {
  if (!item)
    return [
      "[/] reply",
      "[R] review queue",
      "[m] mark FYI read",
      "[r] refresh",
      "[q] quit",
    ];
  const hints: string[] = ["[↑↓] nav", "[/] reply"];
  switch (item.kind) {
    case "notification":
      hints.push("[a] ack");
      break;
    case "work-item":
      hints.push("[A] approve", "[s] snooze");
      break;
    case "signal":
      hints.push("[d] suppress");
      break;
    case "session":
      hints.push("[r] retry", "[k] kill", "[d] dismiss");
      break;
    case "worker":
      hints.push("[p] peek", "[k] kill");
      break;
    case "queue-item":
      hints.push("[D] dispatch", "[b] bump", "[x] archive");
      break;
    case "pr-review":
      hints.push("[P] plannotator", "[↵] open", "[v] mark reviewed");
      break;
    case "blocked-item":
      hints.push("[r] retry", "[l] log", "[x] abandon");
      break;
    case "recent-win":
      hints.push("[d] dismiss");
      break;
    case "idea":
      hints.push("[a] accept", "[p] promote", "[k] kill", "[f] defer");
      break;
  }
  if (item.related_ids.some(looksLikeUrl)) hints.push("[↵] open url");
  hints.push("[R] review queue", "[m] mark FYI read", "[?] help", "[q] quit");
  return hints;
};

const Footer: React.FC<{
  focused: InboxItem | null;
  status: string | null;
  detail: string | null;
}> = ({ focused, status, detail }) => (
  <Box flexDirection="column" marginTop={1}>
    {detail ? <Text color="cyan">{detail}</Text> : null}
    {status ? <Text color="cyan">{status}</Text> : null}
    <Text color="gray">{hintsFor(focused).join("  ")}</Text>
  </Box>
);

const HelpOverlay: React.FC = () => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="cyan"
    paddingX={1}
  >
    <Text bold>Inbox key bindings</Text>
    <Text>
      <Text color="cyan">↑/↓</Text> move cursor
    </Text>
    <Text>
      <Text color="cyan">/</Text> compose natural-language reply (Po enqueues a
      work item)
    </Text>
    <Text>
      <Text color="cyan">Enter</Text> open related URL in $BROWSER
    </Text>
    <Text>
      <Text color="cyan">P</Text> review PR in plannotator (on a pr-review row)
    </Text>
    <Text>
      <Text color="cyan">R</Text> start review queue (walk all open PRs)
    </Text>
    <Text>
      <Text color="cyan">a</Text> ack notification / accept idea
    </Text>
    <Text>
      <Text color="cyan">A</Text> approve + dispatch work item
    </Text>
    <Text>
      <Text color="cyan">d</Text> dismiss · <Text color="cyan">k</Text> kill ·{" "}
      <Text color="cyan">r</Text> retry
    </Text>
    <Text>
      <Text color="cyan">p</Text> peek/promote · <Text color="cyan">l</Text>{" "}
      failure log · <Text color="cyan">f</Text> defer
    </Text>
    <Text>
      <Text color="cyan">v</Text> mark PR reviewed · <Text color="cyan">x</Text>{" "}
      archive / abandon · <Text color="cyan">s</Text> snooze
    </Text>
    <Text>
      <Text color="cyan">m</Text> mark all FYI read
    </Text>
    <Text>
      <Text color="cyan">?</Text> toggle this help · <Text color="cyan">q</Text>{" "}
      quit
    </Text>
  </Box>
);

const ComposeOverlay: React.FC<{
  item: InboxItem | null;
  text: string;
}> = ({ item, text }) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="cyan"
    paddingX={1}
  >
    <Text bold>Reply to Po — enqueues a work item</Text>
    <Text color="gray">target: {item ? item.key : "(no row focused)"}</Text>
    <Text>
      &gt; <Text color="white">{text}</Text>
      <Text color="cyan">▌</Text>
    </Text>
    <Text color="gray">[Enter] send · [Esc] cancel</Text>
  </Box>
);

const TickBanner: React.FC<{ tick: CronTickStatus }> = ({ tick }) => {
  const color = tick.stale ? "yellow" : "cyan";
  const body = tick.stale
    ? `Cron tick in progress ${tick.age_minutes}m (looks stale — last completed ${tick.last_completed_at ?? "never"}) · ${tick.id}`
    : `Cron tick in progress (started ${tick.age_minutes}m ago · ${tick.id})`;
  return (
    <Box marginTop={1}>
      <Text color={color}>⟳ {body}</Text>
    </Box>
  );
};

const findPrUrl = (item: InboxItem): string | null => {
  if (item.kind !== "pr-review") return null;
  return item.related_ids.find((r) => /^https?:\/\//.test(r)) ?? null;
};

const findAllPrUrls = (dashboard: InboxDashboard): string[] => {
  const urls: string[] = [];
  for (const it of dashboard.review) {
    const u = findPrUrl(it);
    if (u) urls.push(u);
  }
  return urls;
};

export const App: React.FC = () => {
  const { exit } = useApp();
  const [dashboard, setDashboard] = useState<InboxDashboard>(() =>
    collectDashboard(),
  );
  const [tickStatus, setTickStatus] = useState<CronTickStatus | null>(() =>
    getCronTickStatus(),
  );
  const [refreshedAt, setRefreshedAt] = useState<Date>(new Date());
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeText, setComposeText] = useState("");

  const refresh = useCallback(() => {
    setDashboard(collectDashboard());
    setTickStatus(getCronTickStatus());
    setRefreshedAt(new Date());
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const sections = useMemo(() => buildSections(dashboard), [dashboard]);
  const flatVisible = useMemo(
    () => sections.flatMap((s) => s.items),
    [sections],
  );
  const flatAll = useMemo(() => flattenDashboard(dashboard), [dashboard]);

  useEffect(() => {
    if (flatVisible.length === 0) {
      if (cursorKey !== null) setCursorKey(null);
      return;
    }
    if (!cursorKey || !flatVisible.some((i) => i.key === cursorKey)) {
      setCursorKey(flatVisible[0].key);
    }
  }, [flatVisible, cursorKey]);

  const focusedItem = useMemo(
    () => flatVisible.find((i) => i.key === cursorKey) ?? null,
    [flatVisible, cursorKey],
  );

  const moveCursor = (delta: number) => {
    if (!flatVisible.length) return;
    const idx = flatVisible.findIndex((i) => i.key === cursorKey);
    const next = Math.max(
      0,
      Math.min(flatVisible.length - 1, (idx === -1 ? 0 : idx) + delta),
    );
    setCursorKey(flatVisible[next].key);
  };

  const flashStatus = (msg: string, ms = 4000) => {
    setStatus(msg);
    setTimeout(() => setStatus(null), ms);
  };

  const flashDetail = (text: string, ms = 8000) => {
    setDetail(text);
    setTimeout(() => setDetail(null), ms);
  };

  const applyResult = (r: ActionResult) => {
    if (r.detail) flashDetail(r.detail);
    flashStatus(r.message);
    refresh();
  };

  useInput(async (input, key) => {
    if (composeOpen) {
      if (key.escape) {
        setComposeOpen(false);
        setComposeText("");
        return;
      }
      if (key.return) {
        const target = focusedItem;
        const text = composeText;
        setComposeOpen(false);
        setComposeText("");
        if (!target) {
          flashStatus("no row focused");
          return;
        }
        applyResult(await enqueueInboxResponse(target.key, text));
        return;
      }
      if (key.backspace || key.delete) {
        setComposeText((t) => t.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setComposeText((t) => t + input);
      }
      return;
    }

    if (showHelp) {
      if (input === "?" || key.escape || input === "q") setShowHelp(false);
      return;
    }
    if (input === "q" || (key.ctrl && input === "c")) {
      exit();
      return;
    }
    if (key.upArrow) return moveCursor(-1);
    if (key.downArrow) return moveCursor(1);
    if (input === "?") {
      setShowHelp(true);
      return;
    }
    if (input === "/") {
      setComposeOpen(true);
      setComposeText("");
      return;
    }
    if (input === "m") {
      applyResult(await markAllFyiRead(flatAll));
      return;
    }
    if (input === "R") {
      const urls = findAllPrUrls(dashboard);
      if (!urls.length) {
        flashStatus("no open PRs to review");
        return;
      }
      applyResult(await startReviewQueue(urls));
      return;
    }
    if (input === "r" && !focusedItem) {
      refresh();
      flashStatus("refreshed", 1500);
      return;
    }
    if (!focusedItem) return;

    if (key.return) {
      const url = focusedItem.related_ids.find(looksLikeUrl);
      if (url) {
        openInBrowser(url);
        flashStatus(`opened ${url}`, 2000);
      } else {
        flashStatus("no related URL on focused item", 2000);
      }
      return;
    }

    switch (focusedItem.kind) {
      case "notification":
        if (input === "a" || input === "d")
          return applyResult(await ackNotification(focusedItem.id));
        break;
      case "work-item":
        if (input === "A")
          return applyResult(await approveWorkItem(focusedItem.id));
        if (input === "s")
          return applyResult(await snoozeWorkItem(focusedItem.id));
        break;
      case "signal":
        if (input === "d")
          return applyResult(await suppressSignal(focusedItem.id));
        break;
      case "session":
        if (input === "r")
          return applyResult(await retrySession(focusedItem.id));
        if (input === "k")
          return applyResult(await killSession(focusedItem.id));
        if (input === "d")
          return applyResult(await dismissSession(focusedItem.id));
        break;
      case "worker":
        if (input === "p")
          return applyResult(await peekSession(focusedItem.id));
        if (input === "k")
          return applyResult(await killSession(focusedItem.id));
        break;
      case "queue-item":
        if (input === "D")
          return applyResult(await dispatchWorkItem(focusedItem.id));
        if (input === "b")
          return applyResult(await bumpWorkItem(focusedItem.id));
        if (input === "x")
          return applyResult(await archiveWorkItem(focusedItem.id));
        break;
      case "pr-review": {
        if (input === "v")
          return applyResult(await markPrReviewed(focusedItem.id));
        if (input === "P") {
          const pr = findPrUrl(focusedItem);
          if (!pr) {
            flashStatus("no PR URL on this row");
            return;
          }
          return applyResult(await reviewInPlannotator(pr));
        }
        break;
      }
      case "blocked-item":
        if (input === "r")
          return applyResult(await retryWorkItem(focusedItem.id));
        if (input === "l")
          return applyResult(await viewFailureLog(focusedItem.id));
        if (input === "x")
          return applyResult(await abandonWorkItem(focusedItem.id));
        break;
      case "recent-win":
        if (input === "d")
          return applyResult(await markPrReviewed(focusedItem.id));
        break;
      case "idea":
        if (input === "a") return applyResult(await acceptIdea(focusedItem.id));
        if (input === "p")
          return applyResult(await promoteIdea(focusedItem.id));
        if (input === "k") return applyResult(await killIdea(focusedItem.id));
        if (input === "f") return applyResult(await deferIdea(focusedItem.id));
        break;
    }

    if (input === "r") {
      refresh();
      flashStatus("refreshed", 1500);
    }
  });

  if (showHelp) {
    return (
      <Box flexDirection="column" padding={1}>
        <HelpOverlay />
        <Text color="gray">press ? or q to close</Text>
      </Box>
    );
  }

  if (composeOpen) {
    return (
      <Box flexDirection="column" padding={1}>
        <ComposeOverlay item={focusedItem} text={composeText} />
      </Box>
    );
  }

  const recentWinsCount = dashboard.recentWins.length;

  return (
    <Box flexDirection="column" padding={1}>
      <Box justifyContent="space-between">
        <Text bold>Inbox</Text>
        <Text color="gray">refreshed {fmtClock(refreshedAt)}</Text>
      </Box>
      {tickStatus ? <TickBanner tick={tickStatus} /> : null}
      {flatVisible.length === 0 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Inbox empty. Po has nothing for you.</Text>
          <Text color="gray">— Po</Text>
        </Box>
      ) : (
        sections.map((section) => {
          if (section.items.length === 0) return null;
          const color = SECTION_COLOR[section.section];
          return (
            <Box key={section.section} flexDirection="column" marginTop={1}>
              <Text bold color={color}>
                {SECTION_TITLES[section.section].toUpperCase()} (
                {section.items.length})
              </Text>
              {section.items.map((item) => (
                <ItemRow
                  key={item.key}
                  item={item}
                  focused={item.key === cursorKey}
                />
              ))}
            </Box>
          );
        })
      )}
      {recentWinsCount > 0 ? (
        <Box marginTop={1}>
          <Text color="gray">
            + {recentWinsCount} shipped in last 24h (see web dashboard to
            expand)
          </Text>
        </Box>
      ) : null}
      {dashboard.triagedIdeasCount > 0 ? (
        <Box>
          <Text color="gray">
            + {dashboard.triagedIdeasCount} triaged ideas · run `cos ideas` to
            browse
          </Text>
        </Box>
      ) : null}
      <Footer focused={focusedItem} status={status} detail={detail} />
    </Box>
  );
};
