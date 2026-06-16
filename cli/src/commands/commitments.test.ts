import { describe, expect, it, vi, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { tmp, ledgerPath } = vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const dir = mkdtempSync(join(tmpdir(), "cos-commitments-cmd-test-"));
  return { tmp: dir, ledgerPath: join(dir, "commitments.md") };
});

vi.mock("../util.js", async () => {
  const actual =
    await vi.importActual<typeof import("../util.js")>("../util.js");
  return { ...actual, COMMITMENTS_MD: ledgerPath };
});

import { cmdCommitmentsAdd } from "./commitments.js";
import { loadLedger } from "../commitments.js";

beforeEach(() => {
  rmSync(ledgerPath, { force: true });
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("cmdCommitmentsAdd sanitization", () => {
  it("converts pipes in `what` to slashes so the line survives a round-trip", () => {
    cmdCommitmentsAdd({ who: "swain", what: "review PR | needs tests" });
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw).toContain("review PR / needs tests");
    expect(raw).not.toContain("review PR | needs tests");
    const items = loadLedger();
    expect(items).toHaveLength(1);
    expect(items[0].what).toBe("review PR / needs tests");
  });

  it("trims whitespace on `who` and lowercases it", () => {
    cmdCommitmentsAdd({ who: "Swain ", what: "thing" });
    const items = loadLedger();
    expect(items[0].who).toBe("swain");
    const raw = readFileSync(ledgerPath, "utf8");
    expect(raw).not.toContain("swain  | ");
  });

  it("sanitizes pipes and trims `source`", () => {
    cmdCommitmentsAdd({
      who: "feliks",
      what: "do thing",
      source: " a | b ",
    });
    const items = loadLedger();
    expect(items[0].source).toBe("a / b");
  });

  it("dedup matches against the sanitized values", () => {
    cmdCommitmentsAdd({ who: "swain", what: "a / b" });
    cmdCommitmentsAdd({ who: "swain ", what: "a | b" });
    expect(loadLedger()).toHaveLength(1);
  });
});
