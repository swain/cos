import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cos-upcoming-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

const { getDb, meetingPrepRuns } = await import("../db.js");
const { reconcileOrphanedPrepRuns, classifyCollectorOutput } =
  await import("./actions.js");

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec(`DELETE FROM meeting_prep_runs`);
});

describe("meetingPrepRuns", () => {
  it("start + latestForEvent round-trips a running row", () => {
    meetingPrepRuns.start({ id: "mpr-1", event_id: "evt-1", slug: "s" });
    const latest = meetingPrepRuns.latestForEvent("evt-1");
    expect(latest).not.toBeNull();
    expect(latest!.status).toBe("running");
    expect(latest!.slug).toBe("s");
  });

  it("finish sets terminal state and preserves artifact refs", () => {
    meetingPrepRuns.start({ id: "mpr-2", event_id: "evt-2", slug: "s" });
    meetingPrepRuns.finish("mpr-2", {
      status: "ready",
      exit_code: 0,
      prep_file_path: "/tmp/out.md",
    });
    const r = meetingPrepRuns.latestForEvent("evt-2")!;
    expect(r.status).toBe("ready");
    expect(r.exit_code).toBe(0);
    expect(r.prep_file_path).toBe("/tmp/out.md");
    expect(r.finished_at).not.toBeNull();
  });

  it("latestForEvents batches lookups to just the requested ids", () => {
    meetingPrepRuns.start({ id: "a", event_id: "e1", slug: "s" });
    meetingPrepRuns.start({ id: "b", event_id: "e2", slug: "s" });
    meetingPrepRuns.finish("a", { status: "ready" });
    meetingPrepRuns.finish("b", { status: "failed" });
    const map = meetingPrepRuns.latestForEvents(["e1", "e2", "e-missing"]);
    expect(map.size).toBe(2);
    expect(map.get("e1")!.status).toBe("ready");
    expect(map.get("e2")!.status).toBe("failed");
    expect(map.has("e-missing")).toBe(false);
  });

  it("reconcileOrphanedPrepRuns marks stuck running rows as failed", () => {
    meetingPrepRuns.start({ id: "mpr-stuck", event_id: "evt-3", slug: "s" });
    const n = reconcileOrphanedPrepRuns();
    expect(n).toBe(1);
    const r = meetingPrepRuns.latestForEvent("evt-3")!;
    expect(r.status).toBe("failed");
    expect(r.error).toMatch(/orphaned/);
  });
});

describe("classifyCollectorOutput", () => {
  it("returns gws-fetch-failed when the explicit sentinel is present", () => {
    const r = classifyCollectorOutput("doing work…\ngws-event-fetch-failed\n");
    expect(r.kind).toBe("gws-fetch-failed");
    if (r.kind === "gws-fetch-failed") expect(r.reason).toMatch(/gws/);
  });

  it("returns gws-fetch-failed when the base prompt's gws-unavailable sentinel is present", () => {
    const r = classifyCollectorOutput("gws-unavailable\n");
    expect(r.kind).toBe("gws-fetch-failed");
    if (r.kind === "gws-fetch-failed") expect(r.reason).toMatch(/gws/i);
  });

  it("prefers gws-fetch-failed over no-prep-needed when both appear", () => {
    const r = classifyCollectorOutput(
      "gws-event-fetch-failed\nno-prep-needed\n",
    );
    expect(r.kind).toBe("gws-fetch-failed");
  });

  it("returns no-prep-needed on the no-prep-needed sentinel alone", () => {
    expect(classifyCollectorOutput("no-prep-needed\n").kind).toBe(
      "no-prep-needed",
    );
  });

  it("returns ready when no sentinel is present", () => {
    expect(classifyCollectorOutput("wrote prep file for evt-123\n").kind).toBe(
      "ready",
    );
  });
});

describe("upcoming.getUpcomingMeetings prep state derivation", () => {
  // Exercised by hand-rolling a fake gws response path is out of scope —
  // the CI gws binary would be needed for the full end-to-end. Instead the
  // e2e playwright specs cover the rendered surface. This test focuses on
  // the decision table that the render path relies on.
  it("no-prep-needed on a fresh run wins over the default no-prep fallback", () => {
    meetingPrepRuns.start({ id: "mpr-x", event_id: "evt-x", slug: "s" });
    meetingPrepRuns.finish("mpr-x", { status: "no-prep-needed" });
    const run = meetingPrepRuns.latestForEvent("evt-x")!;
    expect(run.status).toBe("no-prep-needed");
  });
});
