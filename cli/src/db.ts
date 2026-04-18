import Database from "better-sqlite3";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DB_PATH,
  COS_DIR,
  LOGS_DIR,
  WORKLOGS_DIR,
  MEETINGS_DIR,
  PROMPTS_DIR,
  parseJson,
  slugify,
  parseWorkItemIdArg,
} from "./util.js";
import type {
  WorkItem,
  Idea,
  Signal,
  Session,
  Notification,
  RecurringTask,
  Followup,
} from "./types.js";

let _db: Database.Database | null = null;

export const getDb = (): Database.Database => {
  if (_db) return _db;
  const path = process.env.COS_DB_PATH || DB_PATH;
  if (path === DB_PATH) {
    mkdirSync(COS_DIR, { recursive: true });
    mkdirSync(LOGS_DIR, { recursive: true });
    mkdirSync(WORKLOGS_DIR, { recursive: true });
    mkdirSync(MEETINGS_DIR, { recursive: true });
    mkdirSync(PROMPTS_DIR, { recursive: true });
  }
  _db = new Database(path);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../src/schema.sql"),
    join(COS_DIR, "cli/src/schema.sql"),
  ];
  const schemaPath = candidates.find((p) => existsSync(p));
  if (!schemaPath)
    throw new Error(`schema.sql not found (tried: ${candidates.join(", ")})`);
  _db.exec(readFileSync(schemaPath, "utf8"));
  migrate(_db);
  return _db;
};

const hasColumn = (
  db: Database.Database,
  table: string,
  col: string,
): boolean => {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  return rows.some((r) => r.name === col);
};

const migrate = (db: Database.Database) => {
  if (!hasColumn(db, "work_items", "needs_approval")) {
    db.exec(
      `ALTER TABLE work_items ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0`,
    );
  }
  if (!hasColumn(db, "sessions", "acked_at")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN acked_at TEXT`);
  }
  if (!hasColumn(db, "work_items", "inbox_acked_at")) {
    db.exec(`ALTER TABLE work_items ADD COLUMN inbox_acked_at TEXT`);
  }
  if (!hasColumn(db, "work_items", "parent_id")) {
    db.exec(`ALTER TABLE work_items ADD COLUMN parent_id TEXT`);
  }
  if (!hasColumn(db, "work_items", "needs_planning")) {
    db.exec(
      `ALTER TABLE work_items ADD COLUMN needs_planning INTEGER NOT NULL DEFAULT 0`,
    );
  }
  // num + slug: human-friendly identifiers (wi-42-fix-cos-worktrees).
  // `num` stays nullable so the backfill below can fill existing rows in a
  // controlled pass rather than fighting a NOT NULL default.
  if (!hasColumn(db, "work_items", "num")) {
    db.exec(`ALTER TABLE work_items ADD COLUMN num INTEGER`);
  }
  if (!hasColumn(db, "work_items", "slug")) {
    db.exec(`ALTER TABLE work_items ADD COLUMN slug TEXT NOT NULL DEFAULT ''`);
  }
  // Indexes run after ALTER so they work on both fresh (schema.sql created the
  // columns) and migrated DBs (ALTER just created them).
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_work_items_parent_id ON work_items(parent_id)`,
  );
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_num_unique ON work_items(num) WHERE num IS NOT NULL`,
  );
  // Backfill num in created_at order (earliest = 1) and slug from title.
  const missing = db
    .prepare(
      `SELECT id, title, slug, num FROM work_items WHERE num IS NULL OR slug = '' ORDER BY created_at ASC, id ASC`,
    )
    .all() as { id: string; title: string; slug: string; num: number | null }[];
  if (missing.length) {
    const maxRow = db
      .prepare(`SELECT MAX(num) AS max FROM work_items`)
      .get() as { max: number | null };
    let next = (maxRow.max ?? 0) + 1;
    const update = db.prepare(
      `UPDATE work_items SET num = COALESCE(num, @num), slug = CASE WHEN slug = '' THEN @slug ELSE slug END WHERE id = @id`,
    );
    const tx = db.transaction(() => {
      for (const row of missing) {
        const slug = row.slug || slugify(row.title) || "item";
        const num = row.num ?? next++;
        update.run({ id: row.id, num, slug });
      }
    });
    tx();
  }
};

const rowToWorkItem = (r: any): WorkItem => ({
  id: r.id,
  num: r.num ?? null,
  slug: r.slug ?? "",
  title: r.title,
  description: r.description,
  acceptance_criteria: r.acceptance_criteria,
  repos: parseJson<string[]>(r.repos, []),
  priority: r.priority,
  status: r.status,
  source: r.source,
  depends_on: parseJson<string[]>(r.depends_on, []),
  session_id: r.session_id,
  pr_urls: parseJson<string[]>(r.pr_urls, []),
  worklog_path: r.worklog_path,
  worktree_paths: parseJson<Record<string, string>>(r.worktree_paths, {}),
  needs_approval: !!r.needs_approval,
  inbox_acked_at: r.inbox_acked_at ?? null,
  parent_id: r.parent_id ?? null,
  needs_planning: !!r.needs_planning,
  created_at: r.created_at,
  updated_at: r.updated_at,
  completed_at: r.completed_at,
});

const rowToIdea = (r: any): Idea => ({
  id: r.id,
  title: r.title,
  description: r.description,
  source: r.source,
  confidence: r.confidence,
  repos_guess: parseJson<string[]>(r.repos_guess, []),
  status: r.status,
  promoted_to: r.promoted_to,
  created_at: r.created_at,
});

const rowToSignal = (r: any): Signal => ({
  id: r.id,
  source: r.source,
  kind: r.kind,
  external_id: r.external_id,
  payload: parseJson<Record<string, unknown>>(r.payload, {}),
  status: r.status,
  triaged_at: r.triaged_at,
  created_at: r.created_at,
});

const rowToSession = (r: any): Session => ({
  id: r.id,
  work_item_id: r.work_item_id,
  tmux_window: r.tmux_window,
  kind: r.kind,
  status: r.status,
  current_step: r.current_step,
  last_heartbeat: r.last_heartbeat,
  started_at: r.started_at,
  ended_at: r.ended_at,
  acked_at: r.acked_at,
  notes: r.notes,
});

const rowToNotification = (r: any): Notification => ({
  id: r.id,
  subject: r.subject,
  body: r.body,
  urgency: r.urgency,
  related_ids: parseJson<string[]>(r.related_ids, []),
  pushed_at: r.pushed_at,
  acked_at: r.acked_at,
  created_at: r.created_at,
});

export type WorkItemInsert = Omit<
  WorkItem,
  "num" | "slug" | "created_at" | "updated_at" | "completed_at"
>;

export const workItems = {
  insert(wi: WorkItemInsert): { num: number; slug: string } {
    const db = getDb();
    const slug = slugify(wi.title) || "item";
    const maxRow = db
      .prepare(`SELECT MAX(num) AS max FROM work_items`)
      .get() as { max: number | null };
    const num = (maxRow.max ?? 0) + 1;
    db.prepare(
      `INSERT INTO work_items (id, num, slug, title, description, acceptance_criteria, repos, priority, status, source, depends_on, session_id, pr_urls, worklog_path, worktree_paths, needs_approval, parent_id, needs_planning)
       VALUES (@id, @num, @slug, @title, @description, @acceptance_criteria, @repos, @priority, @status, @source, @depends_on, @session_id, @pr_urls, @worklog_path, @worktree_paths, @needs_approval, @parent_id, @needs_planning)`,
    ).run({
      ...wi,
      num,
      slug,
      repos: JSON.stringify(wi.repos),
      depends_on: JSON.stringify(wi.depends_on),
      pr_urls: JSON.stringify(wi.pr_urls),
      worktree_paths: JSON.stringify(wi.worktree_paths),
      needs_approval: wi.needs_approval ? 1 : 0,
      parent_id: wi.parent_id ?? null,
      needs_planning: wi.needs_planning ? 1 : 0,
    });
    return { num, slug };
  },
  get(id: string): WorkItem | null {
    const r = getDb()
      .prepare("SELECT * FROM work_items WHERE id = ?")
      .get(id) as any;
    return r ? rowToWorkItem(r) : null;
  },
  getByNum(num: number): WorkItem | null {
    const r = getDb()
      .prepare("SELECT * FROM work_items WHERE num = ?")
      .get(num) as any;
    return r ? rowToWorkItem(r) : null;
  },
  // Resolve a user-supplied reference (wi-<ulid>, wi-<num>, wi-<num>-<slug>,
  // or bare <num>) to the full WorkItem row, or null if not found.
  resolve(arg: string): WorkItem | null {
    const ref = parseWorkItemIdArg(arg);
    return ref.kind === "num"
      ? workItems.getByNum(ref.num)
      : workItems.get(ref.id);
  },
  list(filter?: { status?: string; priority?: number }): WorkItem[] {
    let sql = "SELECT * FROM work_items WHERE 1=1";
    const params: any = {};
    if (filter?.status) {
      sql += " AND status = @status";
      params.status = filter.status;
    }
    if (filter?.priority !== undefined) {
      sql += " AND priority = @priority";
      params.priority = filter.priority;
    }
    sql += " ORDER BY priority ASC, created_at ASC";
    return (getDb().prepare(sql).all(params) as any[]).map(rowToWorkItem);
  },
  listChildren(parentId: string): WorkItem[] {
    return (
      getDb()
        .prepare(
          "SELECT * FROM work_items WHERE parent_id = ? ORDER BY created_at ASC",
        )
        .all(parentId) as any[]
    ).map(rowToWorkItem);
  },
  update(id: string, patch: Partial<WorkItem>) {
    const sets: string[] = [];
    const params: any = { id };
    const serialize: Record<string, (v: any) => any> = {
      repos: JSON.stringify,
      depends_on: JSON.stringify,
      pr_urls: JSON.stringify,
      worktree_paths: JSON.stringify,
      needs_approval: (v: boolean) => (v ? 1 : 0),
      needs_planning: (v: boolean) => (v ? 1 : 0),
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = serialize[k] ? serialize[k](v) : v;
    }
    if (!sets.length) return;
    sets.push(`updated_at = datetime('now')`);
    getDb()
      .prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  },
};

export const ideas = {
  insert(i: Omit<Idea, "created_at">) {
    const db = getDb();
    db.prepare(
      `INSERT INTO ideas (id, title, description, source, confidence, repos_guess, status, promoted_to)
       VALUES (@id, @title, @description, @source, @confidence, @repos_guess, @status, @promoted_to)`,
    ).run({ ...i, repos_guess: JSON.stringify(i.repos_guess) });
  },
  get(id: string): Idea | null {
    const r = getDb()
      .prepare("SELECT * FROM ideas WHERE id = ?")
      .get(id) as any;
    return r ? rowToIdea(r) : null;
  },
  list(filter?: { status?: string }): Idea[] {
    let sql = "SELECT * FROM ideas WHERE 1=1";
    const params: any = {};
    if (filter?.status) {
      sql += " AND status = @status";
      params.status = filter.status;
    }
    sql += " ORDER BY created_at DESC";
    return (getDb().prepare(sql).all(params) as any[]).map(rowToIdea);
  },
  update(id: string, patch: Partial<Idea>) {
    const sets: string[] = [];
    const params: any = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = k === "repos_guess" ? JSON.stringify(v) : v;
    }
    if (!sets.length) return;
    getDb()
      .prepare(`UPDATE ideas SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  },
};

export const signals = {
  insert(s: Omit<Signal, "created_at">): { inserted: boolean; id: string } {
    const db = getDb();
    try {
      db.prepare(
        `INSERT INTO signals (id, source, kind, external_id, payload, status, triaged_at)
         VALUES (@id, @source, @kind, @external_id, @payload, @status, @triaged_at)`,
      ).run({ ...s, payload: JSON.stringify(s.payload) });
      return { inserted: true, id: s.id };
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE"))
        return { inserted: false, id: s.id };
      throw e;
    }
  },
  get(id: string): Signal | null {
    const r = getDb()
      .prepare("SELECT * FROM signals WHERE id = ?")
      .get(id) as any;
    return r ? rowToSignal(r) : null;
  },
  list(filter?: { status?: string; source?: string }): Signal[] {
    let sql = "SELECT * FROM signals WHERE 1=1";
    const params: any = {};
    if (filter?.status) {
      sql += " AND status = @status";
      params.status = filter.status;
    }
    if (filter?.source) {
      sql += " AND source = @source";
      params.source = filter.source;
    }
    sql += " ORDER BY created_at DESC";
    return (getDb().prepare(sql).all(params) as any[]).map(rowToSignal);
  },
  update(id: string, patch: Partial<Signal>) {
    const sets: string[] = [];
    const params: any = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = k === "payload" ? JSON.stringify(v) : v;
    }
    if (!sets.length) return;
    getDb()
      .prepare(`UPDATE signals SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  },
};

export const sessions = {
  insert(
    s: Omit<Session, "started_at" | "last_heartbeat" | "ended_at" | "acked_at">,
  ) {
    getDb()
      .prepare(
        `INSERT INTO sessions (id, work_item_id, tmux_window, kind, status, current_step, notes)
       VALUES (@id, @work_item_id, @tmux_window, @kind, @status, @current_step, @notes)`,
      )
      .run(s);
  },
  get(id: string): Session | null {
    const r = getDb()
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(id) as any;
    return r ? rowToSession(r) : null;
  },
  list(filter?: {
    status?: string;
    kind?: string;
    startedSince?: string;
    startedBefore?: string;
  }): Session[] {
    let sql = "SELECT * FROM sessions WHERE 1=1";
    const params: any = {};
    if (filter?.status) {
      sql += " AND status = @status";
      params.status = filter.status;
    }
    if (filter?.kind) {
      sql += " AND kind = @kind";
      params.kind = filter.kind;
    }
    if (filter?.startedSince) {
      sql += " AND started_at >= @startedSince";
      params.startedSince = filter.startedSince;
    }
    if (filter?.startedBefore) {
      sql += " AND started_at < @startedBefore";
      params.startedBefore = filter.startedBefore;
    }
    sql += " ORDER BY started_at DESC";
    return (getDb().prepare(sql).all(params) as any[]).map(rowToSession);
  },
  latestForWorkItem(workItemId: string, status?: string): Session | null {
    let sql = "SELECT * FROM sessions WHERE work_item_id = @wi";
    const params: any = { wi: workItemId };
    if (status) {
      sql += " AND status = @status";
      params.status = status;
    }
    sql += " ORDER BY started_at DESC LIMIT 1";
    const r = getDb().prepare(sql).get(params) as any;
    return r ? rowToSession(r) : null;
  },
  heartbeat(id: string, step?: string) {
    getDb()
      .prepare(
        `UPDATE sessions SET last_heartbeat = datetime('now'), status = CASE WHEN status = 'starting' THEN 'running' ELSE status END, current_step = COALESCE(@step, current_step) WHERE id = @id`,
      )
      .run({ id, step: step ?? null });
  },
  update(id: string, patch: Partial<Session>) {
    const sets: string[] = [];
    const params: any = { id };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || v === undefined) continue;
      sets.push(`${k} = @${k}`);
      params[k] = v;
    }
    if (!sets.length) return;
    getDb()
      .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);
  },
};

export const notifications = {
  insert(n: Omit<Notification, "created_at" | "acked_at">) {
    getDb()
      .prepare(
        `INSERT INTO notifications (id, subject, body, urgency, related_ids, pushed_at)
       VALUES (@id, @subject, @body, @urgency, @related_ids, @pushed_at)`,
      )
      .run({ ...n, related_ids: JSON.stringify(n.related_ids) });
  },
  listUnpushed(): Notification[] {
    return (
      getDb()
        .prepare(
          `SELECT * FROM notifications WHERE pushed_at IS NULL ORDER BY created_at ASC`,
        )
        .all() as any[]
    ).map(rowToNotification);
  },
  markPushed(id: string) {
    getDb()
      .prepare(
        `UPDATE notifications SET pushed_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  },
};

export const cosLog = {
  insert(row: {
    id: string;
    signals_triaged: number;
    ideas_promoted: number;
    items_dispatched: number;
    notifications_sent: number;
    summary: string;
  }) {
    getDb()
      .prepare(
        `INSERT INTO cos_log (id, signals_triaged, ideas_promoted, items_dispatched, notifications_sent, summary)
       VALUES (@id, @signals_triaged, @ideas_promoted, @items_dispatched, @notifications_sent, @summary)`,
      )
      .run(row);
  },
  recent(n = 20) {
    return getDb()
      .prepare(`SELECT * FROM cos_log ORDER BY tick_at DESC LIMIT ?`)
      .all(n) as any[];
  },
};

const rowToRecurringTask = (r: any): RecurringTask => ({
  id: r.id,
  title: r.title,
  cadence_hours: r.cadence_hours,
  prompt_path: r.prompt_path,
  enabled: !!r.enabled,
  last_run_at: r.last_run_at,
  next_run_at: r.next_run_at,
  last_status: r.last_status,
  last_notes: r.last_notes,
  created_at: r.created_at,
});

export const recurring = {
  insert(
    t: Omit<
      RecurringTask,
      "created_at" | "last_run_at" | "last_status" | "last_notes"
    >,
  ) {
    getDb()
      .prepare(
        `INSERT INTO recurring_tasks (id, title, cadence_hours, prompt_path, enabled, next_run_at)
         VALUES (@id, @title, @cadence_hours, @prompt_path, @enabled, @next_run_at)`,
      )
      .run({ ...t, enabled: t.enabled ? 1 : 0 });
  },
  get(id: string): RecurringTask | null {
    const r = getDb()
      .prepare(`SELECT * FROM recurring_tasks WHERE id = ?`)
      .get(id) as any;
    return r ? rowToRecurringTask(r) : null;
  },
  list(filter?: { enabled?: boolean }): RecurringTask[] {
    let sql = `SELECT * FROM recurring_tasks WHERE 1=1`;
    const params: any = {};
    if (filter?.enabled !== undefined) {
      sql += ` AND enabled = @enabled`;
      params.enabled = filter.enabled ? 1 : 0;
    }
    sql += ` ORDER BY next_run_at ASC`;
    return (getDb().prepare(sql).all(params) as any[]).map(rowToRecurringTask);
  },
  listDue(asOf: string): RecurringTask[] {
    return (
      getDb()
        .prepare(
          `SELECT * FROM recurring_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC`,
        )
        .all(asOf) as any[]
    ).map(rowToRecurringTask);
  },
  markRan(
    id: string,
    opts: { status: "ok" | "failed"; notes?: string; asOf?: string },
  ) {
    const t = recurring.get(id);
    if (!t) throw new Error(`recurring task not found: ${id}`);
    const ran = opts.asOf ?? new Date().toISOString();
    const next = new Date(
      new Date(ran).getTime() + t.cadence_hours * 3600_000,
    ).toISOString();
    getDb()
      .prepare(
        `UPDATE recurring_tasks
         SET last_run_at = @ran, next_run_at = @next, last_status = @status, last_notes = @notes
         WHERE id = @id`,
      )
      .run({
        id,
        ran,
        next,
        status: opts.status,
        notes: opts.notes ?? null,
      });
  },
  setEnabled(id: string, enabled: boolean) {
    getDb()
      .prepare(`UPDATE recurring_tasks SET enabled = ? WHERE id = ?`)
      .run(enabled ? 1 : 0, id);
  },
};

export type CronTick = {
  id: string;
  started_at: string;
  ended_at: string | null;
  rc: number | null;
};

export const cronTicks = {
  start(id: string): void {
    getDb().prepare(`INSERT INTO cron_ticks (id) VALUES (?)`).run(id);
  },
  end(id: string, rc: number | null): void {
    getDb()
      .prepare(
        `UPDATE cron_ticks SET ended_at = datetime('now'), rc = @rc WHERE id = @id`,
      )
      .run({ id, rc });
  },
  current(): CronTick | null {
    const r = getDb()
      .prepare(
        `SELECT * FROM cron_ticks WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as any;
    return r ?? null;
  },
  lastCompleted(): CronTick | null {
    const r = getDb()
      .prepare(
        `SELECT * FROM cron_ticks WHERE ended_at IS NOT NULL ORDER BY ended_at DESC LIMIT 1`,
      )
      .get() as any;
    return r ?? null;
  },
};

const rowToFollowup = (r: any): Followup => ({
  id: r.id,
  topic: r.topic,
  context: r.context,
  trigger: r.trigger,
  status: r.status,
  created_at: r.created_at,
  raised_at: r.raised_at,
});

export const followups = {
  insert(f: Omit<Followup, "created_at" | "raised_at">) {
    getDb()
      .prepare(
        `INSERT INTO followups (id, topic, context, trigger, status)
         VALUES (@id, @topic, @context, @trigger, @status)`,
      )
      .run(f);
  },
  get(id: string): Followup | null {
    const r = getDb()
      .prepare(`SELECT * FROM followups WHERE id = ?`)
      .get(id) as any;
    return r ? rowToFollowup(r) : null;
  },
  list(filter?: { status?: string }): Followup[] {
    let sql = `SELECT * FROM followups WHERE 1=1`;
    const params: any = {};
    if (filter?.status) {
      sql += ` AND status = @status`;
      params.status = filter.status;
    }
    sql += ` ORDER BY created_at ASC`;
    return (getDb().prepare(sql).all(params) as any[]).map(rowToFollowup);
  },
  markRaised(id: string) {
    getDb()
      .prepare(
        `UPDATE followups SET status = 'raised', raised_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
  },
  markAddressed(id: string) {
    getDb()
      .prepare(`UPDATE followups SET status = 'addressed' WHERE id = ?`)
      .run(id);
  },
};

export const kv = {
  get(key: string): string | null {
    const r = getDb()
      .prepare(`SELECT value FROM kv WHERE key = ?`)
      .get(key) as any;
    return r ? r.value : null;
  },
  set(key: string, value: string) {
    getDb()
      .prepare(
        `INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value);
  },
};
