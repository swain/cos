import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cos-db-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

const { getDb } = await import("./db.js");

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

// Simulates a fleet.db created by an older version of schema.sql, before
// any of the columns currently added by migrate() existed. Mirrors the
// CREATE TABLE shapes from the initial schema (pre-wi-01KPGKCKDG5X6M6QP84SXK232G).
const PRE_MIGRATION_SCHEMA = `
CREATE TABLE work_items (
  id                  TEXT PRIMARY KEY,
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
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT
);
CREATE TABLE sessions (
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
`;

const seedPreMigrationDb = (path: string) => {
  const db = new Database(path);
  db.exec(PRE_MIGRATION_SCHEMA);
  db.close();
};

describe("getDb() against pre-migration DB", () => {
  it("opens without error and applies all ALTER migrations", () => {
    const path = process.env.COS_DB_PATH!;
    seedPreMigrationDb(path);

    expect(() => getDb()).not.toThrow();

    const db = getDb();
    const workItemCols = (
      db.prepare("PRAGMA table_info(work_items)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    for (const col of [
      "needs_approval",
      "inbox_acked_at",
      "parent_id",
      "needs_planning",
    ]) {
      expect(workItemCols).toContain(col);
    }

    const sessionCols = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    expect(sessionCols).toContain("acked_at");

    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_work_items_parent_id");
  });
});
