import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-idea-triage-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { extractTriageJson, runIdeaTriage } from "./idea-triage.js";
import { getDb, ideas } from "../db.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM ideas;");
});

const insertIdea = (title: string) => {
  const id = `idea-${ulid()}`;
  ideas.insert({
    id,
    title,
    description: "d",
    source: "test",
    confidence: 0.5,
    repos_guess: ["cos"],
    status: "new",
    promoted_to: null,
  });
  return id;
};

describe("extractTriageJson", () => {
  it("picks the last fenced json block", () => {
    const out = `reasoning...\n\`\`\`json\n{"results":[]}\n\`\`\`\n`;
    expect(extractTriageJson(out)).toBe(`{"results":[]}`);
  });

  it("falls back to the outer { ... } when no fence is present", () => {
    const out = `here you go {"results": [{"id": "x"}]} done`;
    expect(extractTriageJson(out)).toBe(`{"results": [{"id": "x"}]}`);
  });

  it("throws when there is no json at all", () => {
    expect(() => extractTriageJson("no json here")).toThrow();
  });
});

describe("runIdeaTriage with --from-file", () => {
  it("writes triage fields to matching ideas only", () => {
    const a = insertIdea("first");
    const b = insertIdea("second");
    const c = insertIdea("third");

    const fixture = {
      results: [
        {
          id: a,
          verdict: "suggest-promote",
          rationale: "clear win",
          score: 0.9,
        },
        {
          id: b,
          verdict: "suggest-kill",
          rationale: "low value",
          score: 0.7,
        },
      ],
    };
    const path = join(tmp, "fixture.json");
    writeFileSync(path, JSON.stringify(fixture));

    const res = runIdeaTriage({ fromFile: path });
    expect(res.errorMessage).toBeUndefined();
    expect(res.triaged).toBe(2);
    expect(res.skipped).toBe(1);

    const updatedA = ideas.get(a);
    expect(updatedA?.triage_verdict).toBe("suggest-promote");
    expect(updatedA?.triage_score).toBe(0.9);
    expect(updatedA?.triaged_at).not.toBeNull();

    // c had no entry in the fixture — stays untriaged.
    expect(ideas.get(c)?.triaged_at).toBeNull();
  });

  it("respects limit and only triages up to N unscored ideas", () => {
    const ids = [insertIdea("a"), insertIdea("b"), insertIdea("c")];
    const fixture = {
      results: ids.map((id) => ({
        id,
        verdict: "your-call",
        rationale: "up to you",
        score: 0.5,
      })),
    };
    const path = join(tmp, "batch.json");
    writeFileSync(path, JSON.stringify(fixture));

    const res = runIdeaTriage({ fromFile: path, limit: 2 });
    expect(res.attempted).toBe(2);
    expect(res.triaged).toBe(2);
    expect(
      ideas.list({ status: "new" }).filter((i) => !i.triaged_at),
    ).toHaveLength(1);
  });
});
