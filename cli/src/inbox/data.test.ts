import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-inbox-data-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { collectDashboard } from "./data.js";
import { markPrReviewed, dismissSession } from "./actions.js";
import { getDb, workItems, sessions } from "../db.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec(
    "DELETE FROM work_items; DELETE FROM sessions; DELETE FROM notifications; DELETE FROM cos_log;",
  );
});

const insertWi = (
  overrides: Partial<Parameters<typeof workItems.insert>[0]> = {},
) => {
  const id = `wi-${ulid()}`;
  workItems.insert({
    id,
    title: "A work item",
    description: "d",
    acceptance_criteria: "a",
    repos: ["cos"],
    priority: 2,
    status: "queued",
    source: "user",
    depends_on: [],
    session_id: null,
    pr_urls: [],
    worklog_path: null,
    worktree_paths: {},
    needs_approval: false,
    parent_id: null,
    needs_planning: false,
    ...overrides,
  });
  return id;
};

describe("recentWinItems respects inbox_acked_at", () => {
  it("includes a freshly merged work item", () => {
    const id = insertWi({ title: "a merged win", status: "merged" });
    const d = collectDashboard();
    expect(d.recentWins.some((i) => i.id === id)).toBe(true);
  });

  it("hides a merged work item after dismiss (markPrReviewed)", async () => {
    const id = insertWi({ title: "dismiss me", status: "merged" });
    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(true);

    const r = await markPrReviewed(id);
    expect(r.ok).toBe(true);

    const after = collectDashboard();
    expect(after.recentWins.some((i) => i.id === id)).toBe(false);
  });

  it("hides a done work item after dismiss (markPrReviewed)", async () => {
    const id = insertWi({ title: "done and dismissed", status: "done" });
    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(true);

    await markPrReviewed(id);

    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(false);
  });
});

describe("anomalyItems respects sessions.acked_at", () => {
  it("hides a failed session after dismiss", async () => {
    const sessId = `sess-${ulid()}`;
    sessions.insert({
      id: sessId,
      work_item_id: null,
      tmux_window: null,
      kind: "worker",
      status: "failed",
      current_step: "editing",
      notes: "boom",
    });

    expect(collectDashboard().anomalies.some((i) => i.id === sessId)).toBe(
      true,
    );

    await dismissSession(sessId);

    expect(collectDashboard().anomalies.some((i) => i.id === sessId)).toBe(
      false,
    );
  });
});

describe("queue items still render (no regression)", () => {
  it("keeps a queued work item visible even after inbox_acked_at is set", () => {
    const id = insertWi({ title: "queued item", status: "queued" });
    getDb()
      .prepare(
        `UPDATE work_items SET inbox_acked_at = datetime('now') WHERE id = ?`,
      )
      .run(id);
    expect(collectDashboard().queue.some((i) => i.id === id)).toBe(true);
  });
});
