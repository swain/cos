import { kv } from "../db.js";

export type CollectedSignal = {
  source: "clickup";
  kind: string;
  external_id: string | null;
  payload: Record<string, unknown>;
};

const API_BASE = "https://api.clickup.com/api/v2";
const LAST_TICK_KEY = "clickup.last_tick_at";
const LOOKBACK_MS_DEFAULT = 24 * 60 * 60 * 1000;
const DEADLINE_WINDOW_MS = 24 * 60 * 60 * 1000;

type ClickupUser = { id: number; username?: string };
type ClickupStatus = { status?: string; id?: string };
type ClickupComment = {
  id: string;
  date?: string;
  comment_text?: string;
  comment?: Array<{ type?: string; user?: ClickupUser; text?: string }>;
  user?: ClickupUser;
};
type ClickupTask = {
  id: string;
  name?: string;
  url?: string;
  date_created?: string;
  date_updated?: string;
  due_date?: string | null;
  status?: ClickupStatus;
  assignees?: ClickupUser[];
  watchers?: ClickupUser[];
};

const cuFetch = async (
  path: string,
  token: string,
  init?: RequestInit,
): Promise<any | null> => {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      console.error(
        `[clickup] ${path} -> ${res.status} ${res.statusText}`.slice(0, 200),
      );
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.error(`[clickup] ${path} failed: ${e.message?.slice(0, 200)}`);
    return null;
  }
};

const toMs = (v?: string | null): number | null => {
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// A comment can carry mentions in two shapes:
//   1. structured `comment[]` entries with type='tag' referencing a user id
//   2. inline `@username` tokens in comment_text
// Match either so we catch both API response variants.
const commentMentionsUser = (
  c: ClickupComment,
  userId: number,
  username?: string,
): boolean => {
  if (Array.isArray(c.comment)) {
    for (const entry of c.comment) {
      if (entry?.type === "tag" && Number(entry.user?.id) === userId) {
        return true;
      }
    }
  }
  if (username && c.comment_text) {
    const token = `@${username}`.toLowerCase();
    if (c.comment_text.toLowerCase().includes(token)) return true;
  }
  return false;
};

const fetchTasks = async (
  token: string,
  teamId: string,
  params: Record<string, string | string[]>,
): Promise<ClickupTask[]> => {
  const tasks: ClickupTask[] = [];
  for (let page = 0; page < 5; page++) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const x of v) qs.append(k, x);
      else qs.append(k, v);
    }
    qs.append("page", String(page));
    const body = await cuFetch(`/team/${teamId}/task?${qs.toString()}`, token);
    const batch = (body?.tasks ?? []) as ClickupTask[];
    tasks.push(...batch);
    if (batch.length < 100) break;
  }
  return tasks;
};

export const collectClickupSignals = async (): Promise<CollectedSignal[]> => {
  const out: CollectedSignal[] = [];
  const token = process.env.CLICKUP_API_TOKEN;
  if (!token) return out;

  const me = (await cuFetch("/user", token)) as { user?: ClickupUser } | null;
  const userId = me?.user?.id;
  const username = me?.user?.username;
  if (!userId) {
    console.error("[clickup] could not resolve user id");
    return out;
  }

  let teamId = process.env.CLICKUP_TEAM_ID;
  if (!teamId) {
    const teams = (await cuFetch("/team", token)) as {
      teams?: Array<{ id: string }>;
    } | null;
    teamId = teams?.teams?.[0]?.id;
  }
  if (!teamId) {
    console.error("[clickup] could not resolve team id");
    return out;
  }

  const now = Date.now();
  const lastTickIso = kv.get(LAST_TICK_KEY);
  const sinceMs = lastTickIso
    ? new Date(lastTickIso).getTime()
    : now - LOOKBACK_MS_DEFAULT;

  const assigned = await fetchTasks(token, teamId, {
    "assignees[]": String(userId),
    date_updated_gt: String(sinceMs),
    include_closed: "false",
    subtasks: "true",
  });

  for (const t of assigned) {
    const createdMs = toMs(t.date_created);
    const status = t.status?.status ?? t.status?.id ?? "unknown";
    if (createdMs && createdMs > sinceMs) {
      out.push({
        source: "clickup",
        kind: "clickup-task-assigned",
        external_id: `clickup-task:${t.id}:created`,
        payload: {
          task_id: t.id,
          name: t.name,
          url: t.url,
          status,
          created_at: createdMs,
        },
      });
    }
    out.push({
      source: "clickup",
      kind: "clickup-task-assigned",
      external_id: `clickup-task:${t.id}:status:${status}`,
      payload: {
        task_id: t.id,
        name: t.name,
        url: t.url,
        status,
        event: "status",
      },
    });
    const dueMs = toMs(t.due_date);
    if (dueMs && dueMs >= now && dueMs - now <= DEADLINE_WINDOW_MS) {
      out.push({
        source: "clickup",
        kind: "clickup-deadline",
        external_id: `clickup-task:${t.id}:due:${dueMs}`,
        payload: {
          task_id: t.id,
          name: t.name,
          url: t.url,
          due_date: dueMs,
        },
      });
    }
  }

  // Watched-task mentions. ClickUp supports `watchers[]` on the filtered
  // team tasks endpoint; if the workspace is empty or the filter returns
  // nothing new, we just skip.
  const watched = await fetchTasks(token, teamId, {
    "watchers[]": String(userId),
    date_updated_gt: String(sinceMs),
    include_closed: "false",
    subtasks: "true",
  });

  for (const t of watched) {
    const body = (await cuFetch(
      `/task/${t.id}/comment?start_date=${sinceMs}`,
      token,
    )) as { comments?: ClickupComment[] } | null;
    for (const c of body?.comments ?? []) {
      if (!commentMentionsUser(c, userId, username)) continue;
      if (Number(c.user?.id) === userId) continue;
      out.push({
        source: "clickup",
        kind: "clickup-mention",
        external_id: `clickup-comment:${c.id}`,
        payload: {
          task_id: t.id,
          task_name: t.name,
          task_url: t.url,
          comment_id: c.id,
          comment_text: c.comment_text,
          author: c.user?.username,
        },
      });
    }
  }

  kv.set(LAST_TICK_KEY, new Date(now).toISOString());
  return out;
};
