import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-tick-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { cmdSessionMarkStale } from "./tick.js";
import { sessions, getDb } from "../db.js";

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
