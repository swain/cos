import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmp = mkdtempSync(join(tmpdir(), "cos-notify-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { buildAppleScript, cmdNotify, cmdNotifyPush } from "./notify.js";
import { notifications, getDb } from "../db.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM notifications;");
});

describe("buildAppleScript", () => {
  it("escapes double quotes in subject and body", () => {
    const out = buildAppleScript('he said "hi"', 'with "quotes"', "normal");
    expect(out).toBe(
      'display notification "with \\"quotes\\"" with title "he said \\"hi\\""',
    );
  });

  it("escapes backslashes before quotes so escape sequences stay well-formed", () => {
    const out = buildAppleScript("a\\b", 'c\\"d', "normal");
    expect(out).toBe('display notification "c\\\\\\"d" with title "a\\\\b"');
  });

  it("adds Submarine sound for urgent urgency", () => {
    const out = buildAppleScript("s", "b", "urgent");
    expect(out).toContain('sound name "Submarine"');
  });

  it("omits sound for normal urgency", () => {
    const out = buildAppleScript("s", "b", "normal");
    expect(out).not.toContain("sound name");
  });
});

describe("cmdNotifyPush", () => {
  it("is a no-op on already-pushed notifications", () => {
    const id = cmdNotify({ subject: "s", body: "b", urgency: "normal" });
    notifications.markPushed(id);
    const before = notifications.get(id)?.pushed_at;
    expect(before).toBeTruthy();

    cmdNotifyPush(id);

    expect(notifications.get(id)?.pushed_at).toBe(before);
  });

  it("exits 1 on unknown id", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code}`);
    }) as never);
    expect(() => cmdNotifyPush("notif-does-not-exist")).toThrow("exit:1");
    exit.mockRestore();
  });

  it("--dry-run does not mark pushed", () => {
    const id = cmdNotify({ subject: "s", body: "b", urgency: "urgent" });
    cmdNotifyPush(id, { dryRun: true });
    expect(notifications.get(id)?.pushed_at).toBeNull();
  });
});
