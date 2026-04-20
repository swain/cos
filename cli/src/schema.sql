-- COS fleet.db schema. Idempotent.

CREATE TABLE IF NOT EXISTS work_items (
  id                  TEXT PRIMARY KEY,
  num                 INTEGER UNIQUE,
  slug                TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL,
  description         TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  repos               TEXT NOT NULL DEFAULT '[]',
  priority            INTEGER NOT NULL DEFAULT 3,
  status              TEXT NOT NULL DEFAULT 'queued',
  source              TEXT NOT NULL DEFAULT 'user',
  depends_on          TEXT NOT NULL DEFAULT '[]',
  session_id          TEXT,
  pr_urls             TEXT NOT NULL DEFAULT '[]',
  worklog_path        TEXT,
  worktree_paths      TEXT NOT NULL DEFAULT '{}',
  parent_id           TEXT,
  needs_planning      INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_work_items_status_priority ON work_items(status, priority);
-- Note: idx_work_items_parent_id and idx_work_items_num are created by migrate()
-- in db.ts so schema.sql stays safe on pre-migration databases that lack those
-- columns (CREATE INDEX fails if the column is missing even with IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS ideas (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  source            TEXT NOT NULL DEFAULT 'user',
  confidence        REAL NOT NULL DEFAULT 0.5,
  repos_guess       TEXT NOT NULL DEFAULT '[]',
  status            TEXT NOT NULL DEFAULT 'new',
  promoted_to       TEXT,
  triage_verdict    TEXT,
  triage_rationale  TEXT,
  triage_score      REAL,
  triaged_at        TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas(status);
-- Note: idx_ideas_triaged_at is created by migrate() in db.ts so this file
-- stays safe on pre-triage databases (CREATE INDEX fails if the column
-- is missing, even with IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS signals (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  external_id TEXT,
  payload     TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'new',
  triaged_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe ON signals(source, kind, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  work_item_id   TEXT,
  tmux_window    TEXT,
  kind           TEXT NOT NULL DEFAULT 'worker',
  status         TEXT NOT NULL DEFAULT 'starting',
  current_step   TEXT,
  last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at       TEXT,
  notes          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_work_item ON sessions(work_item_id);
CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  urgency     TEXT NOT NULL DEFAULT 'normal',
  related_ids TEXT NOT NULL DEFAULT '[]',
  pushed_at   TEXT,
  acked_at    TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_pushed ON notifications(pushed_at);

CREATE TABLE IF NOT EXISTS cos_log (
  id                  TEXT PRIMARY KEY,
  tick_at             TEXT NOT NULL DEFAULT (datetime('now')),
  signals_triaged     INTEGER NOT NULL DEFAULT 0,
  ideas_promoted      INTEGER NOT NULL DEFAULT 0,
  items_dispatched    INTEGER NOT NULL DEFAULT 0,
  notifications_sent  INTEGER NOT NULL DEFAULT 0,
  summary             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cron_ticks (
  id         TEXT PRIMARY KEY,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at   TEXT,
  rc         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cron_ticks_ended ON cron_ticks(ended_at);
CREATE INDEX IF NOT EXISTS idx_cron_ticks_started ON cron_ticks(started_at);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS followups (
  id         TEXT PRIMARY KEY,
  topic      TEXT NOT NULL,
  context    TEXT NOT NULL DEFAULT '',
  trigger    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  raised_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_followups_status ON followups(status);
CREATE INDEX IF NOT EXISTS idx_followups_trigger ON followups(trigger);

CREATE TABLE IF NOT EXISTS meeting_prep_runs (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL,
  slug           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'running',
  started_at     TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at    TEXT,
  exit_code      INTEGER,
  prep_file_path TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_meeting_prep_runs_event ON meeting_prep_runs(event_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_prep_runs_status ON meeting_prep_runs(status);

-- Plans awaiting / post user review. Surfaces in the dashboard Review section
-- (alongside PR-review rows). Lifecycle: awaiting-review → approved | feedback
-- | superseded. `feedback_body` holds the inline comment bundle written back
-- by plannotator on "send feedback"; resubmit reads it as prompt context.
CREATE TABLE IF NOT EXISTS plans (
  id            TEXT PRIMARY KEY,
  work_item_id  TEXT,
  path          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'awaiting-review',
  feedback_body TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_work_item ON plans(work_item_id);

CREATE TABLE IF NOT EXISTS recurring_tasks (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  cadence_hours  INTEGER NOT NULL,
  prompt_path    TEXT NOT NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  last_run_at    TEXT,
  next_run_at    TEXT NOT NULL,
  last_status    TEXT,
  last_notes     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_recurring_tasks_due ON recurring_tasks(enabled, next_run_at);
