import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-doctor-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { checkInvariant9StrandedWorkItem, runDoctor } from "./doctor.js";
import { workItems, sessions, getDb } from "../db.js";

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

const insertSession = (overrides: {
  id?: string;
  work_item_id?: string | null;
  status?: string;
  last_heartbeat?: string;
  ended_at?: string | null;
}) => {
  const id = overrides.id ?? `sess-${ulid()}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, work_item_id, kind, status, last_heartbeat, started_at, ended_at)
       VALUES (@id, @wi, 'worker', @status, @hb, @started, @ended)`,
    )
    .run({
      id,
      wi: overrides.work_item_id ?? null,
      status: overrides.status ?? "running",
      hb: overrides.last_heartbeat ?? new Date().toISOString(),
      started: new Date(Date.now() - 3_600_000).toISOString(),
      ended: overrides.ended_at ?? null,
    });
  return id;
};

const insertWorkItem = (overrides: {
  id?: string;
  status?: string;
  session_id?: string | null;
  worktree_paths?: Record<string, string>;
}) => {
  const id = overrides.id ?? `wi-${ulid()}`;
  workItems.insert({
    id,
    title: "test WI",
    description: "",
    acceptance_criteria: "",
    repos: ["cos"],
    priority: 3,
    status: (overrides.status ?? "in-progress") as any,
    source: "user",
    depends_on: [],
    session_id: overrides.session_id ?? null,
    pr_urls: [],
    worklog_path: null,
    worktree_paths: overrides.worktree_paths ?? { cos: "/tmp/wt/cos" },
    needs_approval: false,
  });
  return id;
};

describe("doctor: stranded-work-item invariant", () => {
  it("resets in-progress WIs whose linked session is stale", () => {
    const sessId = insertSession({
      status: "stale",
      last_heartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      ended_at: new Date().toISOString(),
    });
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: sessId,
      worktree_paths: { cos: "/tmp/wt/cos-stale" },
    });
    sessions.update(sessId, { work_item_id: wiId });

    const report = runDoctor({
      autoFix: true,
      dryRun: false,
      format: "json",
    });

    const finding = report.findings.find(
      (f) => f.invariant === "stranded-work-item",
    );
    expect(finding).toBeDefined();
    expect(finding!.ok).toBe(false);
    expect(finding!.entries.some((e) => e.id === wiId)).toBe(true);
    expect(finding!.fixed.some((x) => x.id === wiId)).toBe(true);

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("queued");
    expect(wi.session_id).toBeNull();
    expect(wi.worktree_paths).toEqual({ cos: "/tmp/wt/cos-stale" });
  });

  it("also catches failed, killed, and completed session statuses", () => {
    for (const status of ["failed", "killed", "completed"]) {
      const sessId = insertSession({
        status,
        ended_at: new Date().toISOString(),
      });
      const wiId = insertWorkItem({
        status: "in-progress",
        session_id: sessId,
      });
      sessions.update(sessId, { work_item_id: wiId });

      runDoctor({ autoFix: true, dryRun: false, format: "json" });

      const wi = workItems.get(wiId)!;
      expect(wi.status, `status=${status}`).toBe("queued");
      expect(wi.session_id).toBeNull();
    }
  });

  it("catches in-progress WIs with null session_id (belt-and-suspenders)", () => {
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: null,
    });

    runDoctor({ autoFix: true, dryRun: false, format: "json" });

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("queued");
  });

  it("leaves in-progress WIs with an active session alone", () => {
    // Using the invariant directly rather than runDoctor so the tmux-zombie
    // invariant (which can't see a real tmux session in tests) doesn't kill
    // the session out from under us.
    const sessId = insertSession({
      status: "running",
      last_heartbeat: new Date().toISOString(),
    });
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: sessId,
    });
    sessions.update(sessId, { work_item_id: wiId });

    const finding = checkInvariant9StrandedWorkItem({
      autoFix: true,
      dryRun: false,
      format: "json",
    });

    expect(finding.ok).toBe(true);
    expect(finding.entries).toHaveLength(0);
    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("in-progress");
    expect(wi.session_id).toBe(sessId);
  });

  it("also treats idle sessions as active", () => {
    const sessId = insertSession({ status: "idle" });
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: sessId,
    });
    sessions.update(sessId, { work_item_id: wiId });

    const finding = checkInvariant9StrandedWorkItem({
      autoFix: true,
      dryRun: false,
      format: "json",
    });
    expect(finding.ok).toBe(true);

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("in-progress");
  });

  it("handles session_id pointing at a missing session", () => {
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: "sess-does-not-exist",
    });

    const finding = checkInvariant9StrandedWorkItem({
      autoFix: true,
      dryRun: false,
      format: "json",
    });
    expect(finding.ok).toBe(false);
    expect(finding.entries.some((e) => e.id === wiId)).toBe(true);

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("queued");
    expect(wi.session_id).toBeNull();
  });

  it("dry-run reports but does not mutate", () => {
    const sessId = insertSession({
      status: "stale",
      ended_at: new Date().toISOString(),
    });
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: sessId,
    });
    sessions.update(sessId, { work_item_id: wiId });

    const report = runDoctor({
      autoFix: true,
      dryRun: true,
      format: "json",
    });

    const finding = report.findings.find(
      (f) => f.invariant === "stranded-work-item",
    )!;
    expect(finding.ok).toBe(false);
    expect(finding.entries.some((e) => e.id === wiId)).toBe(true);
    expect(finding.fixed).toHaveLength(0);

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("in-progress");
    expect(wi.session_id).toBe(sessId);
  });

  it("reports but does not mutate when autoFix=false", () => {
    const sessId = insertSession({
      status: "stale",
      ended_at: new Date().toISOString(),
    });
    const wiId = insertWorkItem({
      status: "in-progress",
      session_id: sessId,
    });
    sessions.update(sessId, { work_item_id: wiId });

    const report = runDoctor({
      autoFix: false,
      dryRun: false,
      format: "json",
    });

    const finding = report.findings.find(
      (f) => f.invariant === "stranded-work-item",
    )!;
    expect(finding.ok).toBe(false);
    expect(finding.fixed).toHaveLength(0);

    const wi = workItems.get(wiId)!;
    expect(wi.status).toBe("in-progress");
  });

  it("fleet-wide crash scenario: 17 stranded WIs all get reset", () => {
    const wiIds: string[] = [];
    for (let i = 0; i < 17; i++) {
      const sessId = insertSession({
        status: "stale",
        last_heartbeat: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        ended_at: new Date().toISOString(),
      });
      const wiId = insertWorkItem({
        status: "in-progress",
        session_id: sessId,
      });
      sessions.update(sessId, { work_item_id: wiId });
      wiIds.push(wiId);
    }

    runDoctor({ autoFix: true, dryRun: false, format: "json" });

    for (const wiId of wiIds) {
      const wi = workItems.get(wiId)!;
      expect(wi.status).toBe("queued");
      expect(wi.session_id).toBeNull();
    }
  });
});
