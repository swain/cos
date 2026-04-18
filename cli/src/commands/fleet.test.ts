import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";
import chalk from "chalk";

chalk.level = 3;

const tmp = mkdtempSync(join(tmpdir(), "cos-fleet-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import {
  collectFleet,
  renderFleetTable,
  renderFleetMarkdown,
} from "./fleet.js";
import { workItems, sessions, getDb } from "../db.js";

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ANSI, "");

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

describe("renderFleetTable", () => {
  it("renders a header summary and an empty body when there's nothing to show", () => {
    const out = strip(renderFleetTable(collectFleet(), { termWidth: 120 }));
    expect(out).toContain("COS Fleet");
    expect(out).toContain("Queued:          0");
    expect(out).toContain("In progress:     0");
    expect(out).not.toContain("WORK ITEMS");
    expect(out).not.toContain("PRS AWAITING REVIEW");
    expect(out).not.toContain("SESSIONS");
  });

  it("renders a work-items table with the expected columns", () => {
    insertWi({ title: "A queued item", priority: 1 });
    insertWi({
      title: "An in-progress item",
      status: "in-progress",
      priority: 3,
    });
    insertWi({
      title: "A PR-open item",
      status: "pr-open",
      priority: 2,
      pr_urls: ["https://github.com/swain/cos/pull/123"],
    });

    const out = strip(renderFleetTable(collectFleet(), { termWidth: 140 }));

    expect(out).toContain("WORK ITEMS (3)");
    expect(out).toMatch(/ID\s+P\s+STATUS\s+STEP\s+HB\s+TITLE/);
    expect(out).toContain("A queued item");
    expect(out).toContain("An in-progress item");
    expect(out).toContain("A PR-open item");

    expect(out).toContain("PRS AWAITING REVIEW (1)");
    expect(out).toContain("swain/cos#123");
  });

  it("truncates long titles and long ids with an ellipsis", () => {
    insertWi({
      title: "x".repeat(300),
      status: "queued",
    });
    const out = strip(renderFleetTable(collectFleet(), { termWidth: 120 }));
    expect(out).toMatch(/…/);
    for (const line of out.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  const insertSessionWithHeartbeat = (
    wiId: string,
    minutesAgo: number,
    step: string,
  ) => {
    const sessId = `sess-${ulid()}`;
    sessions.insert({
      id: sessId,
      work_item_id: wiId,
      tmux_window: null,
      kind: "worker",
      status: "running",
      current_step: step,
      notes: null,
    });
    const when = new Date(Date.now() - minutesAgo * 60 * 1000);
    const stamp = when.toISOString().replace("T", " ").slice(0, 19);
    sessions.update(sessId, {
      last_heartbeat: stamp,
      started_at: stamp,
    });
    return sessId;
  };

  it("formats heartbeat age as 1m / 14m / 2h / 3d based on last_heartbeat", () => {
    const wiId = insertWi({ title: "with sess", status: "in-progress" });
    insertSessionWithHeartbeat(wiId, 120, "editing");
    const out = strip(renderFleetTable(collectFleet(), { termWidth: 160 }));
    expect(out).toMatch(/2h\b/);
    expect(out).toContain("editing");
  });

  it("colors stale heartbeats in red and active step in green", () => {
    const wiId = insertWi({ title: "old sess", status: "in-progress" });
    insertSessionWithHeartbeat(wiId, 90, "editing");
    const raw = renderFleetTable(collectFleet(), {
      termWidth: 160,
      staleMinutes: 20,
    });
    expect(raw).toMatch(/\x1b\[31m[^\x1b]*1h/);
    expect(raw).toMatch(/\x1b\[32mediting/);
  });
});

describe("renderFleetMarkdown (unchanged)", () => {
  it("still produces markdown headings", () => {
    insertWi({ title: "q1" });
    const md = renderFleetMarkdown(collectFleet());
    expect(md).toContain("# COS Status");
    expect(md).toContain("## Queued");
    expect(md).toContain("- Queued: **1**");
  });
});
