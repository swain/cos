import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { signals } from "../db.js";
import { appendGoogleAuthUser, MEETINGS_DIR, slugify } from "../util.js";
import type { InboxItem } from "./types.js";

// Fetch calendar events on the user's primary calendar in the next 8 hours
// via the `gws` CLI. The CLI is a wrapper around the Google Calendar API
// that writes to a keychain-backed credential store; on first call it may
// emit `Using keyring backend: keyring` on stderr, which we swallow.
//
// Shape reference: https://developers.google.com/calendar/api/v3/reference/events#resource

type GwsEvent = {
  id: string;
  status?: string;
  eventType?: string;
  summary?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: Array<{
    email?: string;
    responseStatus?: string;
    self?: boolean;
    organizer?: boolean;
    resource?: boolean;
  }>;
  hangoutLink?: string;
  location?: string;
  transparency?: string;
};

type GwsEventList = { items?: GwsEvent[] };

export type UpcomingMeeting = {
  id: string;
  summary: string;
  startMs: number;
  endMs: number;
  attendeeCount: number;
  hangoutLink: string | null;
  prepStatus: "prep-ready" | "prep-pending" | "no-prep";
  prepPath: string | null;
  prepSlug: string;
};

const CACHE_TTL_MS = 2 * 60 * 1000;
const LOOKAHEAD_MS = 8 * 60 * 60 * 1000;

// Block "meeting-ish" events only. Working location, OOO, focus time and
// all-day events are calendar noise for this surface. Also drop events the
// user declined or that have been marked cancelled.
const isRealMeeting = (e: GwsEvent): boolean => {
  if (e.status === "cancelled") return false;
  if (e.eventType && e.eventType !== "default") return false;
  if (!e.start?.dateTime) return false; // all-day or malformed
  const me = (e.attendees ?? []).find((a) => a.self);
  if (me?.responseStatus === "declined") return false;
  return true;
};

const countAttendees = (e: GwsEvent): number => {
  const list = e.attendees ?? [];
  const counted = list.filter(
    (a) => !a.self && !a.resource && a.responseStatus !== "declined",
  );
  return counted.length;
};

// Mirrors the slug convention in prompts/calendar-collect.md so the filename
// we compute here matches the one the collector writes on disk.
const prepSlug = (summary: string, startIso: string): string => {
  const date = new Date(startIso);
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${slugify(summary || "meeting")}`;
};

type PrepFileIndex = { byExact: Set<string>; files: string[] };

const readPrepIndex = (): PrepFileIndex => {
  if (!existsSync(MEETINGS_DIR)) return { byExact: new Set(), files: [] };
  const files = readdirSync(MEETINGS_DIR).filter((f) => f.endsWith(".md"));
  return {
    byExact: new Set(files.map((f) => f.replace(/\.md$/, ""))),
    files,
  };
};

const lookupPendingSignalEventIds = (): Set<string> => {
  const out = new Set<string>();
  for (const s of signals.list({ status: "new", source: "calendar" })) {
    if (s.kind === "meeting-prep-ready" && s.external_id)
      out.add(s.external_id);
  }
  return out;
};

const fetchEventsWithGws = (
  timeMin: string,
  timeMax: string,
): GwsEvent[] | null => {
  // Test / CI escape hatch — tests run the inbox server inside a temp DB and
  // have no calendar auth; without the gate every render would pay the gws
  // spawn cost (and in CI the binary may not exist at all).
  if (process.env.COS_DISABLE_UPCOMING === "1") return null;

  const params = JSON.stringify({
    calendarId: "primary",
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
    maxResults: 50,
  });
  let res;
  try {
    res = spawnSync(
      "gws",
      ["calendar", "events", "list", "--params", params, "--format", "json"],
      { encoding: "utf8", timeout: 5_000 },
    );
  } catch {
    return null;
  }
  // Suppress keyring stderr — it prints every invocation and is not actionable.
  if (res.error || res.status !== 0) return null;
  if (!res.stdout) return null;
  try {
    const parsed = JSON.parse(res.stdout) as GwsEventList;
    return parsed.items ?? [];
  } catch {
    return null;
  }
};

type UpcomingCache = {
  at: number;
  value: UpcomingMeeting[];
};

let cache: UpcomingCache | null = null;

export const invalidateUpcomingCache = () => {
  cache = null;
};

export const getUpcomingMeetings = (): UpcomingMeeting[] => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.value;

  const now = Date.now();
  const timeMin = new Date(now).toISOString();
  const timeMax = new Date(now + LOOKAHEAD_MS).toISOString();
  const events = fetchEventsWithGws(timeMin, timeMax);
  if (events === null) {
    cache = { at: now, value: [] };
    return [];
  }

  const prepIndex = readPrepIndex();
  const pendingEventIds = lookupPendingSignalEventIds();

  const value: UpcomingMeeting[] = [];
  for (const e of events) {
    if (!isRealMeeting(e)) continue;
    const startIso = e.start!.dateTime!;
    const startMs = new Date(startIso).getTime();
    if (Number.isNaN(startMs)) continue;
    if (startMs < now) continue;
    if (startMs - now > LOOKAHEAD_MS) continue;
    const endIso = e.end?.dateTime ?? startIso;
    const endMs = new Date(endIso).getTime() || startMs;

    const slug = prepSlug(e.summary ?? "meeting", startIso);
    const hasFile = prepIndex.byExact.has(slug);
    const prepPath = hasFile ? `${MEETINGS_DIR}/${slug}.md` : null;
    const pending = !hasFile && pendingEventIds.has(e.id);

    value.push({
      id: e.id,
      summary: e.summary ?? "(untitled)",
      startMs,
      endMs,
      attendeeCount: countAttendees(e),
      hangoutLink: e.hangoutLink ? appendGoogleAuthUser(e.hangoutLink) : null,
      prepStatus: hasFile ? "prep-ready" : pending ? "prep-pending" : "no-prep",
      prepPath,
      prepSlug: slug,
    });
  }

  value.sort((a, b) => a.startMs - b.startMs);
  cache = { at: now, value };
  return value;
};

// Rendering helpers — kept in this module so data shape and presentation
// stay colocated; inbox-serve / App both consume these.

const isSameLocalDay = (a: number, b: number): boolean => {
  const da = new Date(a);
  const db = new Date(b);
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const formatAbsoluteLocal = (ms: number): string => {
  const d = new Date(ms);
  const hh = d.getHours();
  const mm = pad2(d.getMinutes());
  const suffix = hh >= 12 ? "pm" : "am";
  const h12 = ((hh + 11) % 12) + 1;
  return `${h12}:${mm}${suffix}`;
};

export const formatRelativeStart = (ms: number, nowMs = Date.now()): string => {
  const deltaMin = Math.round((ms - nowMs) / 60_000);
  if (deltaMin <= 0) return "starting now";
  if (deltaMin < 60) return `in ${deltaMin} min`;
  if (isSameLocalDay(ms, nowMs)) {
    const h = Math.floor(deltaMin / 60);
    const m = deltaMin % 60;
    return m ? `in ${h}h ${m}m` : `in ${h}h`;
  }
  return `tomorrow ${formatAbsoluteLocal(ms)}`;
};

export const upcomingToItem = (
  m: UpcomingMeeting,
  nowMs = Date.now(),
): InboxItem => {
  const rel = formatRelativeStart(m.startMs, nowMs);
  const abs = formatAbsoluteLocal(m.startMs);
  const attendeeLabel =
    m.attendeeCount === 1 ? "1 attendee" : `${m.attendeeCount} attendees`;
  const body = `${rel} · ${abs} · ${attendeeLabel}`;
  return {
    key: `upcoming:${m.id}`,
    kind: "upcoming-meeting",
    id: m.id,
    section: "upcoming",
    urgency: m.prepStatus === "prep-ready" ? "normal" : "urgent",
    subject: m.summary,
    body,
    related_ids: m.hangoutLink ? [m.hangoutLink] : [],
    created_at: new Date(m.startMs).toISOString(),
    meta: {
      startMs: m.startMs,
      endMs: m.endMs,
      attendees: m.attendeeCount,
      prepStatus: m.prepStatus,
      prepPath: m.prepPath,
      prepSlug: m.prepSlug,
      hangoutLink: m.hangoutLink,
      relative: rel,
      absolute: abs,
    },
  };
};

export const upcomingMeetingsItems = (): InboxItem[] => {
  const now = Date.now();
  return getUpcomingMeetings().map((m) => upcomingToItem(m, now));
};
