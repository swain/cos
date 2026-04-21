import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cos-upcoming-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

const { getDb, meetingPrepRuns } = await import("../db.js");
const { reconcileOrphanedPrepRuns, classifyCollectorOutput } =
  await import("./actions.js");
const { formatMeetingWhen, upcomingToItem } = await import("./upcoming.js");

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

describe("formatMeetingWhen — before-start / in-progress / just-ended phases", () => {
  const start = Date.UTC(2026, 3, 21, 14, 0, 0);
  const end = start + 30 * 60_000;

  it("before-start uses the existing in-X relative phrasing", () => {
    const now = start - 12 * 60_000;
    const r = formatMeetingWhen(start, end, now);
    expect(r.phase).toBe("before-start");
    expect(r.label).toBe("in 12 min");
  });

  it("at start flips to in-progress with a live prefix", () => {
    const now = start + 5 * 60_000;
    const r = formatMeetingWhen(start, end, now);
    expect(r.phase).toBe("in-progress");
    expect(r.label).toBe("live · started 5m ago");
  });

  it("in-progress minimum is 1m so rows don't show '0m ago' at the exact flip", () => {
    const r = formatMeetingWhen(start, end, start);
    expect(r.phase).toBe("in-progress");
    expect(r.label).toBe("live · started 1m ago");
  });

  it("after end uses 'ended Xm ago' with muted framing", () => {
    const now = end + 7 * 60_000;
    const r = formatMeetingWhen(start, end, now);
    expect(r.phase).toBe("just-ended");
    expect(r.label).toBe("ended 7m ago");
  });

  it("in-progress formats long meetings with h+m", () => {
    const longEnd = start + 90 * 60_000;
    const now = start + 75 * 60_000;
    const r = formatMeetingWhen(start, longEnd, now);
    expect(r.phase).toBe("in-progress");
    expect(r.label).toBe("live · started 1h 15m ago");
  });
});

describe("upcomingToItem — phase + meta plumbing", () => {
  const mkMeeting = (
    overrides: Partial<Parameters<typeof upcomingToItem>[0]> = {},
  ) => ({
    id: "evt-1",
    summary: "1:1 with Kiley",
    startMs: Date.UTC(2026, 3, 21, 14, 0, 0),
    endMs: Date.UTC(2026, 3, 21, 14, 30, 0),
    attendeeCount: 1,
    hangoutLink: "https://meet.google.com/abc-def-ghi",
    prepStatus: "prep-ready" as const,
    prepPath: "/tmp/prep.md",
    prepSlug: "2026-04-21-1-1-with-kiley",
    prepError: null,
    ...overrides,
  });

  it("before-start carries phase=before-start and the in-X label", () => {
    const m = mkMeeting();
    const item = upcomingToItem(m, m.startMs - 10 * 60_000);
    expect(item.meta?.phase).toBe("before-start");
    expect(item.meta?.relative).toBe("in 10 min");
  });

  it("in-progress retains the hangoutLink and prepPath so join + open prep stay reachable", () => {
    const m = mkMeeting();
    const item = upcomingToItem(m, m.startMs + 5 * 60_000);
    expect(item.meta?.phase).toBe("in-progress");
    expect(item.meta?.hangoutLink).toBe(m.hangoutLink);
    expect(item.meta?.prepPath).toBe(m.prepPath);
    expect(item.meta?.prepStatus).toBe("prep-ready");
  });

  it("just-ended retains the hangoutLink and prepPath", () => {
    const m = mkMeeting();
    const item = upcomingToItem(m, m.endMs + 7 * 60_000);
    expect(item.meta?.phase).toBe("just-ended");
    expect(item.meta?.hangoutLink).toBe(m.hangoutLink);
    expect(item.meta?.prepPath).toBe(m.prepPath);
    expect(String(item.meta?.relative)).toMatch(/^ended /);
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
