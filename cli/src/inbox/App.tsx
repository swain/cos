import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { spawn } from "node:child_process";
import {
  collectInbox,
  groupByBand,
  getCronTickStatus,
  type CronTickStatus,
} from "./data.js";
import {
  ackNotification,
  approveWorkItem,
  markAllFyiRead,
  snoozeWorkItem,
  suppressSignal,
  type ActionResult,
} from "./actions.js";
import type { Band, InboxItem } from "./types.js";

const REFRESH_MS = 3000;
const SECTION_LIMIT = 5;

const SECTION_TITLES: Record<Band, string> = {
  decision: "NEEDS DECISION",
  fyi: "FYI",
  digest: "DIGEST",
};

const URGENCY_COLOR: Record<InboxItem["urgency"], string | undefined> = {
  urgent: "red",
  normal: undefined,
  digest: "gray",
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
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;

const looksLikeUrl = (s: string) => /^https?:\/\//.test(s);

const openInBrowser = (url: string) => {
  spawn("open", [url], { stdio: "ignore", detached: true }).unref();
};

type Section = {
  band: Band;
  total: number;
  visible: InboxItem[];
};

const buildSections = (items: InboxItem[]): Section[] => {
  const grouped = groupByBand(items);
  return (["decision", "fyi", "digest"] as Band[]).map((band) => {
    const all = grouped[band];
    const visible = band === "decision" ? all : all.slice(0, SECTION_LIMIT);
    return { band, total: all.length, visible };
  });
};

type ItemRowProps = {
  item: InboxItem;
  focused: boolean;
};

const ItemRow: React.FC<ItemRowProps> = ({ item, focused }) => {
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

const Footer: React.FC<{
  focused: InboxItem | null;
  status: string | null;
}> = ({ focused, status }) => {
  const hints: string[] = ["[↑↓] nav"];
  if (focused) {
    if (focused.kind === "notification") hints.push("[a] ack");
    if (focused.kind === "work-item") {
      hints.push("[A] approve");
      hints.push("[s] snooze");
    }
    if (focused.kind === "signal" || focused.kind === "notification")
      hints.push("[d] suppress");
    if (focused.related_ids.some(looksLikeUrl)) hints.push("[↵] open");
  }
  hints.push("[r] refresh");
  hints.push("[m] mark fyi read");
  hints.push("[?] help");
  hints.push("[q] quit");
  return (
    <Box flexDirection="column" marginTop={1}>
      {status ? <Text color="cyan">{status}</Text> : null}
      <Text color="gray">{hints.join("  ")}</Text>
    </Box>
  );
};

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
      <Text color="cyan">Enter</Text> open related URL in $BROWSER
    </Text>
    <Text>
      <Text color="cyan">a</Text> ack notification (mark pushed)
    </Text>
    <Text>
      <Text color="cyan">A</Text> approve + dispatch work item
    </Text>
    <Text>
      <Text color="cyan">s</Text> snooze work item (priority +1)
    </Text>
    <Text>
      <Text color="cyan">d</Text> suppress signal / dismiss notif
    </Text>
    <Text>
      <Text color="cyan">r</Text> force refresh
    </Text>
    <Text>
      <Text color="cyan">m</Text> mark all FYI as read
    </Text>
    <Text>
      <Text color="cyan">?</Text> toggle this help
    </Text>
    <Text>
      <Text color="cyan">q</Text> quit
    </Text>
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

export const App: React.FC = () => {
  const { exit } = useApp();
  const [items, setItems] = useState<InboxItem[]>(() => collectInbox());
  const [tickStatus, setTickStatus] = useState<CronTickStatus | null>(() =>
    getCronTickStatus(),
  );
  const [refreshedAt, setRefreshedAt] = useState<Date>(new Date());
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);

  const refresh = useCallback(() => {
    setItems(collectInbox());
    setTickStatus(getCronTickStatus());
    setRefreshedAt(new Date());
  }, []);

  useEffect(() => {
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const sections = useMemo(() => buildSections(items), [items]);

  const flatVisible = useMemo(
    () => sections.flatMap((s) => s.visible),
    [sections],
  );

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

  const applyResult = (r: ActionResult) => {
    setStatus(r.message);
    refresh();
    setTimeout(() => setStatus(null), 4000);
  };

  useInput(async (input, key) => {
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
    if (input === "r") {
      refresh();
      setStatus("refreshed");
      setTimeout(() => setStatus(null), 1500);
      return;
    }
    if (input === "m") {
      applyResult(await markAllFyiRead(items));
      return;
    }
    if (!focusedItem) return;
    if (key.return) {
      const url = focusedItem.related_ids.find(looksLikeUrl);
      if (url) {
        openInBrowser(url);
        setStatus(`opened ${url}`);
        setTimeout(() => setStatus(null), 2000);
      } else {
        setStatus("no related URL on focused item");
        setTimeout(() => setStatus(null), 2000);
      }
      return;
    }
    if (input === "a" && focusedItem.kind === "notification") {
      applyResult(await ackNotification(focusedItem.id));
      return;
    }
    if (input === "A" && focusedItem.kind === "work-item") {
      applyResult(await approveWorkItem(focusedItem.id));
      return;
    }
    if (input === "s" && focusedItem.kind === "work-item") {
      applyResult(await snoozeWorkItem(focusedItem.id));
      return;
    }
    if (input === "d") {
      if (focusedItem.kind === "signal") {
        applyResult(await suppressSignal(focusedItem.id));
        return;
      }
      if (focusedItem.kind === "notification") {
        applyResult(await ackNotification(focusedItem.id));
        return;
      }
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
          const hidden = section.total - section.visible.length;
          return (
            <Box key={section.band} flexDirection="column" marginTop={1}>
              <Text bold>
                {SECTION_TITLES[section.band]} ({section.total})
              </Text>
              {section.visible.length === 0 ? (
                <Text color="gray"> (none)</Text>
              ) : (
                section.visible.map((item) => (
                  <ItemRow
                    key={item.key}
                    item={item}
                    focused={item.key === cursorKey}
                  />
                ))
              )}
              {hidden > 0 ? <Text color="gray"> +{hidden} more</Text> : null}
            </Box>
          );
        })
      )}
      <Footer focused={focusedItem} status={status} />
    </Box>
  );
};
