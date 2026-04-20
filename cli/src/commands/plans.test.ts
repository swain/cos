import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "cos-plans-test-"));
  process.env.COS_DB_PATH = join(tmp, "fleet.db");
  process.env.COS_PLANS_DIR = join(tmp, "plans");
  vi.resetModules();
});

afterEach(async () => {
  const { getDb } = await import("./../db.js");
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdPlanSubmit", () => {
  it("inserts an awaiting-review plans row linked to the work item", async () => {
    const { cmdEnqueue } = await import("./enqueue.js");
    const { cmdPlanSubmit } = await import("./plans.js");
    const { plans } = await import("./../db.js");

    const wiId = cmdEnqueue({
      title: "Ship widget",
      description: "Bake + ship",
      acceptance: "",
      repos: ["cos"],
      priority: 3,
    });

    const planFile = join(tmp, "plan.md");
    writeFileSync(planFile, "# Plan: Ship widget\n\nDo the thing.\n");
    const planId = cmdPlanSubmit(wiId, { path: planFile });

    const p = plans.get(planId!);
    expect(p).not.toBeNull();
    expect(p!.status).toBe("awaiting-review");
    expect(p!.work_item_id).toBe(wiId);
    expect(p!.path).toContain(tmp);
  });
});

describe("summarizePlan", () => {
  it("extracts the H1 title and first paragraph blurb", async () => {
    const { summarizePlan } = await import("./plans.js");
    const p = join(tmp, "a.md");
    writeFileSync(
      p,
      "# Ship the thing\n\nOverview paragraph here.\n\n## Next\n\nFoo.\n",
    );
    expect(summarizePlan(p)).toEqual({
      title: "Ship the thing",
      blurb: "Overview paragraph here.",
    });
  });

  it("falls back to the filename when no H1 is present", async () => {
    const { summarizePlan } = await import("./plans.js");
    const p = join(tmp, "no-h1.md");
    writeFileSync(p, "Just some text\n");
    expect(summarizePlan(p).title).toBe("no-h1.md");
  });
});

describe("decidePlanReviewAction", () => {
  it("prompts on empty stdout (plannotator exited without feedback)", async () => {
    const { decidePlanReviewAction } = await import("./plans.js");
    expect(decidePlanReviewAction("")).toEqual({ kind: "prompt" });
    expect(decidePlanReviewAction("   \n\n  ")).toEqual({ kind: "prompt" });
  });

  it("prompts when plannotator emits the empty-feedback sentinel", async () => {
    const { decidePlanReviewAction } = await import("./plans.js");
    expect(decidePlanReviewAction("No feedback provided.")).toEqual({
      kind: "prompt",
    });
    expect(decidePlanReviewAction("No feedback provided.\n")).toEqual({
      kind: "prompt",
    });
  });

  it("resubmits with the trimmed feedback body on a real submission", async () => {
    const { decidePlanReviewAction } = await import("./plans.js");
    expect(
      decidePlanReviewAction("\nMake option 3 use the accent color.\n"),
    ).toEqual({
      kind: "resubmit",
      feedback: "Make option 3 use the accent color.",
    });
  });
});

describe("cmdPlanResubmit", () => {
  it("updates the plan row with status=feedback and the feedback body, and records reviewed_at", async () => {
    const { cmdEnqueue } = await import("./enqueue.js");
    const { cmdPlanSubmit, cmdPlanResubmit } = await import("./plans.js");
    const { plans } = await import("./../db.js");

    const wiId = cmdEnqueue({
      title: "Ship widget",
      description: "Bake + ship",
      acceptance: "",
      repos: ["cos"],
      priority: 3,
    });
    const planFile = join(tmp, "plan.md");
    writeFileSync(planFile, "# Plan\n\nStep 1.\n");
    const planId = cmdPlanSubmit(wiId, { path: planFile });

    cmdPlanResubmit(planId!, { feedback: "option 2 is better" });

    const p = plans.get(planId!)!;
    expect(p.status).toBe("feedback");
    expect(p.feedback_body).toBe("option 2 is better");
    expect(p.reviewed_at).not.toBeNull();
  });
});

describe("doctor: plan-awaiting-review-ageout invariant", () => {
  it("marks plans older than 7 days as superseded under autoFix", async () => {
    const { getDb, plans } = await import("./../db.js");
    const { runDoctor } = await import("./doctor.js");

    // Seed two plans: one fresh, one 8d old.
    const db = getDb();
    const freshId = "plan-fresh";
    const staleId = "plan-stale";
    db.prepare(
      `INSERT INTO plans (id, path, status, created_at) VALUES (?, ?, 'awaiting-review', datetime('now'))`,
    ).run(freshId, join(tmp, "fresh.md"));
    db.prepare(
      `INSERT INTO plans (id, path, status, created_at) VALUES (?, ?, 'awaiting-review', datetime('now', '-8 days'))`,
    ).run(staleId, join(tmp, "stale.md"));

    const report = runDoctor({
      autoFix: true,
      dryRun: false,
      format: "text",
    });
    const finding = report.findings.find(
      (f) => f.invariant === "plan-awaiting-review-ageout",
    );
    expect(finding).toBeDefined();
    expect(finding!.ok).toBe(false);
    expect(finding!.fixed.length).toBe(1);
    expect(plans.get(staleId)!.status).toBe("superseded");
    expect(plans.get(freshId)!.status).toBe("awaiting-review");
  });

  it("does not mutate under dryRun", async () => {
    const { getDb, plans } = await import("./../db.js");
    const { runDoctor } = await import("./doctor.js");
    const db = getDb();
    db.prepare(
      `INSERT INTO plans (id, path, status, created_at) VALUES ('p1', ?, 'awaiting-review', datetime('now', '-30 days'))`,
    ).run(join(tmp, "x.md"));

    runDoctor({ autoFix: true, dryRun: true, format: "text" });
    expect(plans.get("p1")!.status).toBe("awaiting-review");
  });
});
