import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-workitems-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import {
  buildModeAddendum,
  checkPendingPlanBlocksDispatch,
  cmdWorkerDone,
} from "./workitems.js";
import { workItems, sessions, plans, getDb } from "../db.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec(
    "DELETE FROM work_items; DELETE FROM sessions; DELETE FROM notifications; DELETE FROM cos_log; DELETE FROM plans;",
  );
});

const insertWi = (
  overrides: Partial<Parameters<typeof workItems.insert>[0]> = {},
) => {
  const id = `wi-${ulid()}`;
  workItems.insert({
    id,
    title: "test WI",
    description: "desc",
    acceptance_criteria: "accept",
    repos: ["cos"],
    priority: 3,
    status: "in-progress",
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

const insertSession = (workItemId: string | null) => {
  const id = `sess-${ulid()}`;
  sessions.insert({
    id,
    work_item_id: workItemId,
    tmux_window: null,
    kind: "worker",
    status: "running",
    current_step: null,
    notes: null,
  });
  return id;
};

describe("cmdWorkerDone --failed", () => {
  it("requeues the WI when the failure is a safety-net mechanical exit", () => {
    const wiId = insertWi({ status: "in-progress" });
    const sessId = insertSession(wiId);
    workItems.update(wiId, { session_id: sessId });

    cmdWorkerDone(sessId, {
      failed: "worker shell exited. last output: zsh: command not found",
    });

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("queued");
    expect(wi.session_id).toBeNull();
    const s = sessions.get(sessId)!;
    expect(s.status).toBe("failed");
  });

  it("blocks the WI when the worker reports a genuine blocker", () => {
    const wiId = insertWi({ status: "in-progress" });
    const sessId = insertSession(wiId);
    workItems.update(wiId, { session_id: sessId });

    cmdWorkerDone(sessId, { failed: "stuck on flaky test for 15 min" });

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("blocked");
    expect(wi.session_id).toBeNull();
  });

  it("is idempotent when session is already completed", () => {
    const wiId = insertWi({
      status: "pr-open",
      pr_urls: ["https://example/1"],
    });
    const sessId = insertSession(wiId);
    sessions.update(sessId, { status: "completed" });

    cmdWorkerDone(sessId, { failed: "worker shell exited. last output: " });

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("pr-open");
  });

  it("preserves pr-open status when a fix-comments worker exits mechanically", () => {
    const wiId = insertWi({
      status: "pr-open",
      pr_urls: ["https://example/42"],
    });
    const sessId = insertSession(wiId);
    workItems.update(wiId, { session_id: sessId });

    cmdWorkerDone(sessId, {
      failed: "worker shell exited. last output: zsh: killed",
    });

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("pr-open");
    expect(wi.session_id).toBeNull();
  });
});

describe("buildModeAddendum", () => {
  it("returns empty string for a fresh work item with no PR", () => {
    const wiId = insertWi({ status: "in-progress" });
    const wi = workItems.get(wiId)!;
    expect(buildModeAddendum(wi, "sess-test")).toBe("");
  });

  it("emits fix-comments instructions when the WI already has a PR URL", () => {
    const wiId = insertWi({
      status: "pr-open",
      pr_urls: ["https://github.com/swain/cos/pull/99"],
    });
    const wi = workItems.get(wiId)!;
    const addendum = buildModeAddendum(wi, "sess-test-42");
    expect(addendum).toContain("Fix-comments mode");
    expect(addendum).toContain("https://github.com/swain/cos/pull/99");
    expect(addendum).toContain("sess-test-42");
    expect(addendum).toContain("do NOT open a second PR");
  });

  it("uses the most recent PR URL when multiple are recorded", () => {
    const wiId = insertWi({
      status: "pr-open",
      pr_urls: [
        "https://github.com/swain/cos/pull/1",
        "https://github.com/swain/cos/pull/2",
      ],
    });
    const wi = workItems.get(wiId)!;
    const addendum = buildModeAddendum(wi, "sess-x");
    expect(addendum).toContain("pull/2");
    expect(addendum).not.toContain("pull/1 ");
  });
});

describe("checkPendingPlanBlocksDispatch", () => {
  it("returns null when the WI has no plans", () => {
    const wiId = insertWi({ status: "queued" });
    expect(checkPendingPlanBlocksDispatch(wiId)).toBeNull();
  });

  it("blocks dispatch when the latest plan is awaiting-review", () => {
    const wiId = insertWi({ status: "queued" });
    plans.insert({
      id: "plan-pending",
      work_item_id: wiId,
      path: "/tmp/plan.md",
    });
    const msg = checkPendingPlanBlocksDispatch(wiId);
    expect(msg).not.toBeNull();
    expect(msg).toContain("awaiting review");
    expect(msg).toContain("plan-pending");
  });

  it("blocks dispatch when the latest plan is feedback (re-plan in flight)", () => {
    const wiId = insertWi({ status: "queued" });
    plans.insert({
      id: "plan-fb",
      work_item_id: wiId,
      path: "/tmp/plan.md",
    });
    plans.update("plan-fb", {
      status: "feedback",
      feedback_body: "please make it shorter",
    });
    const msg = checkPendingPlanBlocksDispatch(wiId);
    expect(msg).not.toBeNull();
    expect(msg).toContain("got feedback");
  });

  it("allows dispatch when the latest plan is approved (execute path)", () => {
    const wiId = insertWi({ status: "queued" });
    plans.insert({
      id: "plan-ok",
      work_item_id: wiId,
      path: "/tmp/plan.md",
    });
    plans.update("plan-ok", { status: "approved" });
    expect(checkPendingPlanBlocksDispatch(wiId)).toBeNull();
  });

  it("allows dispatch when an older plan is feedback but a newer plan is approved", () => {
    const wiId = insertWi({ status: "queued" });
    // `datetime('now')` in SQLite has second-resolution, so tight-loop inserts
    // can tie on created_at and make ORDER BY non-deterministic. Stamp the two
    // rows with explicit, distinct created_at values instead.
    const db = getDb();
    db.prepare(
      "INSERT INTO plans (id, work_item_id, path, status, created_at) VALUES (?, ?, '/tmp/old.md', 'feedback', '2026-01-01 00:00:00')",
    ).run("plan-old", wiId);
    db.prepare(
      "INSERT INTO plans (id, work_item_id, path, status, created_at) VALUES (?, ?, '/tmp/new.md', 'approved', '2026-01-02 00:00:00')",
    ).run("plan-new", wiId);
    expect(checkPendingPlanBlocksDispatch(wiId)).toBeNull();
  });
});
