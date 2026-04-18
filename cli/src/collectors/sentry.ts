import { readFileSync, existsSync } from "node:fs";
import { WATCHED_SERVICES_JSON, parseJson } from "../util.js";
import { kv } from "../db.js";

export type CollectedSignal = {
  source: "sentry";
  kind: string;
  external_id: string | null;
  payload: Record<string, unknown>;
};

type ServiceEntry = string | { project: string; org?: string };

type WatchedServicesFile = {
  org?: string;
  region_url?: string;
  services?: ServiceEntry[];
  new_errors_window?: string;
  spike_window?: string;
  spike_threshold_events?: number;
};

type SentryIssue = {
  id: string;
  shortId?: string;
  title?: string;
  culprit?: string;
  level?: string;
  status?: string;
  firstSeen?: string;
  lastSeen?: string;
  count?: string | number;
  userCount?: number;
  permalink?: string;
  project?: { id?: string; slug?: string; name?: string };
};

const DEFAULT_SERVICES: ServiceEntry[] = [
  { project: "gp-api" },
  { project: "gp-webapp" },
  { project: "people-api" },
  { project: "election-api" },
];

const DEFAULT_ORG = "goodparty";
const DEFAULT_REGION_URL = "https://us.sentry.io";
const DEFAULT_NEW_ERRORS_WINDOW = "1h";
const DEFAULT_SPIKE_WINDOW = "15m";
const DEFAULT_SPIKE_THRESHOLD_EVENTS = 50;

type ResolvedConfig = {
  org: string;
  region_url: string;
  services: ServiceEntry[];
  new_errors_window: string;
  spike_window: string;
  spike_threshold_events: number;
};

const loadConfig = (): ResolvedConfig => {
  const cfg = existsSync(WATCHED_SERVICES_JSON)
    ? parseJson<WatchedServicesFile>(
        readFileSync(WATCHED_SERVICES_JSON, "utf8"),
        {},
      )
    : {};
  return {
    org: cfg.org ?? DEFAULT_ORG,
    region_url: (cfg.region_url ?? DEFAULT_REGION_URL).replace(/\/+$/, ""),
    services: cfg.services?.length ? cfg.services : DEFAULT_SERVICES,
    new_errors_window: cfg.new_errors_window ?? DEFAULT_NEW_ERRORS_WINDOW,
    spike_window: cfg.spike_window ?? DEFAULT_SPIKE_WINDOW,
    spike_threshold_events:
      cfg.spike_threshold_events ?? DEFAULT_SPIKE_THRESHOLD_EVENTS,
  };
};

const projectSlug = (svc: ServiceEntry): string =>
  typeof svc === "string" ? svc : svc.project;

const projectOrg = (svc: ServiceEntry, defaultOrg: string): string =>
  typeof svc === "string" ? defaultOrg : (svc.org ?? defaultOrg);

const sentryToken = (): string | null =>
  process.env.SENTRY_AUTH_TOKEN?.trim() || null;

const sentryFetch = async <T>(
  regionUrl: string,
  path: string,
  token: string,
): Promise<T | null> => {
  const url = path.startsWith("http") ? path : `${regionUrl}${path}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) {
      console.error(
        `[sentry] ${res.status} ${res.statusText} for ${url.slice(0, 160)}`,
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (e: any) {
    console.error(
      `[sentry] fetch error: ${e.message?.slice(0, 200) ?? String(e)}`,
    );
    return null;
  }
};

const issueEventCount = (issue: SentryIssue): number => {
  const raw = issue.count;
  if (raw === undefined || raw === null) return 0;
  const n = typeof raw === "string" ? parseInt(raw, 10) : raw;
  return Number.isFinite(n) ? n : 0;
};

const kvKey = (org: string, project: string) =>
  `sentry:last-check:${org}/${project}`;

export type CollectSentryOpts = {
  dryRun?: boolean;
};

export const collectSentrySignals = async (
  opts: CollectSentryOpts = {},
): Promise<CollectedSignal[]> => {
  const out: CollectedSignal[] = [];
  const token = sentryToken();
  if (!token) {
    console.error(
      "[sentry] SENTRY_AUTH_TOKEN not set — skipping (see USING_COS.md § Sentry signals)",
    );
    return out;
  }

  const cfg = loadConfig();
  const nowIso = new Date().toISOString();

  for (const svc of cfg.services) {
    const project = projectSlug(svc);
    const org = projectOrg(svc, cfg.org);

    // (a) New unresolved issues first-seen within new_errors_window.
    const newIssuesPath =
      `/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/` +
      `?query=${encodeURIComponent("is:unresolved")}` +
      `&statsPeriod=${encodeURIComponent(cfg.new_errors_window)}` +
      `&sort=new&limit=25`;
    const newIssues =
      (await sentryFetch<SentryIssue[]>(
        cfg.region_url,
        newIssuesPath,
        token,
      )) ?? [];

    const lastCheck = kv.get(kvKey(org, project));
    for (const issue of newIssues) {
      if (!issue.firstSeen) continue;
      if (lastCheck && issue.firstSeen <= lastCheck) continue;
      out.push({
        source: "sentry",
        kind: "sentry-new-error",
        external_id: issue.permalink ?? `sentry:${org}/${project}/${issue.id}`,
        payload: {
          org,
          project,
          issue_id: issue.id,
          short_id: issue.shortId,
          title: issue.title,
          culprit: issue.culprit,
          level: issue.level,
          first_seen: issue.firstSeen,
          last_seen: issue.lastSeen,
          events: issueEventCount(issue),
          users: issue.userCount,
          permalink: issue.permalink,
        },
      });
    }

    // (b) Error-rate spikes: any unresolved issue with >= threshold events in
    // the spike_window. Dedupe key includes the window so the same issue can
    // spike multiple times over the day without being swallowed.
    const spikePath =
      `/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/issues/` +
      `?query=${encodeURIComponent("is:unresolved")}` +
      `&statsPeriod=${encodeURIComponent(cfg.spike_window)}` +
      `&sort=freq&limit=10`;
    const spikeCandidates =
      (await sentryFetch<SentryIssue[]>(cfg.region_url, spikePath, token)) ??
      [];
    for (const issue of spikeCandidates) {
      const events = issueEventCount(issue);
      if (events < cfg.spike_threshold_events) continue;
      out.push({
        source: "sentry",
        kind: "sentry-error-spike",
        external_id: `spike:${issue.permalink ?? `${org}/${project}/${issue.id}`}:${cfg.spike_window}`,
        payload: {
          org,
          project,
          issue_id: issue.id,
          short_id: issue.shortId,
          title: issue.title,
          window: cfg.spike_window,
          threshold: cfg.spike_threshold_events,
          events,
          users: issue.userCount,
          permalink: issue.permalink,
        },
      });
    }

    if (!opts.dryRun) kv.set(kvKey(org, project), nowIso);
  }

  return out;
};

export const describeSentryConfig = (): ResolvedConfig => loadConfig();
