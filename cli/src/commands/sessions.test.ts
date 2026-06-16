import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-sessions-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { cmdSessionMarkStale } from "./sessions.js";
import { sessions, cronTicks, getDb, ZOMBIE_SWEEP_RC } from "../db.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM sessions;");
});

const insertSession = (status: string): string => {
  const id = `sess-${ulid()}`;
  getDb()
    .prepare(
      `INSERT INTO sessions (id, kind, status, last_heartbeat, started_at, ended_at)
       VALUES (@id, 'worker', @status, @hb, @started, @ended)`,
    )
    .run({
      id,
      status,
      hb: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      started: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      ended: status === "running" ? null : new Date().toISOString(),
    });
  return id;
};

describe("cmdSessionMarkStale", () => {
  it("flips live sessions to stale", () => {
    const id = insertSession("running");
    cmdSessionMarkStale(id);
    expect(sessions.get(id)!.status).toBe("stale");
  });

  it("is a no-op on terminal-status sessions (wi-58)", () => {
    // Regression: the cron claude agent was re-flipping terminal sessions to
    // 'stale' via this command when their heartbeat was old.
    for (const status of [
      "ended",
      "completed",
      "failed",
      "killed",
      "stale",
      "archived",
    ]) {
      const id = insertSession(status);
      cmdSessionMarkStale(id);
      expect(sessions.get(id)!.status, `status=${status}`).toBe(status);
    }
  });

  it("exits 2 on missing session", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit ${code}`);
    }) as any);
    expect(() => cmdSessionMarkStale("sess-does-not-exist")).toThrow(/exit 2/);
    exit.mockRestore();
  });
});

describe("cronTicks.sweepZombies", () => {
  beforeEach(() => {
    getDb().exec("DELETE FROM cron_ticks;");
  });

  const insertTick = (opts: {
    id?: string;
    startedMinutesAgo: number;
    ended?: boolean;
    rc?: number | null;
  }): string => {
    const id = opts.id ?? `tick-${ulid()}`;
    getDb()
      .prepare(
        `INSERT INTO cron_ticks (id, started_at, ended_at, rc)
         VALUES (@id, datetime('now', @startedOffset), @ended_at, @rc)`,
      )
      .run({
        id,
        startedOffset: `-${opts.startedMinutesAgo} minutes`,
        ended_at: opts.ended ? new Date().toISOString() : null,
        rc: opts.rc ?? null,
      });
    return id;
  };

  it("reaps unended rows older than 5 minutes with rc=-1", () => {
    const zombieId = insertTick({ startedMinutesAgo: 10 });
    const result = cronTicks.sweepZombies();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(zombieId);
    expect(result[0].age_minutes).toBeGreaterThanOrEqual(10);

    const reaped = getDb()
      .prepare(`SELECT ended_at, rc FROM cron_ticks WHERE id = ?`)
      .get(zombieId) as any;
    expect(reaped.ended_at).not.toBeNull();
    expect(reaped.rc).toBe(ZOMBIE_SWEEP_RC);
  });

  it("leaves fresh unended rows alone (the current tick)", () => {
    const currentId = insertTick({ startedMinutesAgo: 1 });
    const result = cronTicks.sweepZombies();
    expect(result).toHaveLength(0);

    const row = getDb()
      .prepare(`SELECT ended_at, rc FROM cron_ticks WHERE id = ?`)
      .get(currentId) as any;
    expect(row.ended_at).toBeNull();
    expect(row.rc).toBeNull();
  });

  it("leaves already-ended rows alone", () => {
    const completedId = insertTick({
      startedMinutesAgo: 30,
      ended: true,
      rc: 0,
    });
    const result = cronTicks.sweepZombies();
    expect(result).toHaveLength(0);

    const row = getDb()
      .prepare(`SELECT rc FROM cron_ticks WHERE id = ?`)
      .get(completedId) as any;
    expect(row.rc).toBe(0);
  });

  it("returns empty when no zombies exist", () => {
    expect(cronTicks.sweepZombies()).toEqual([]);
  });
});
