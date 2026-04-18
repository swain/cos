import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-plan-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import { cmdPlan, extractPlanJson, validatePlan, type Plan } from "./plan.js";
import { workItems, getDb } from "../db.js";
import { runDoctor } from "./doctor.js";

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

const insertParent = (
  overrides: Partial<Parameters<typeof workItems.insert>[0]> = {},
) => {
  const id = `wi-${ulid()}`;
  workItems.insert({
    id,
    title: "Parent feature",
    description: "A multi-repo feature that needs decomposition.",
    acceptance_criteria: "Decomposed into PR-sized chunks.",
    repos: ["cos", "gp-api"],
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
    needs_planning: true,
    ...overrides,
  });
  return id;
};

describe("plan: extractPlanJson", () => {
  it("extracts a single fenced json block", () => {
    const out = 'reasoning\n\n```json\n{"chunks":[]}\n```\n';
    expect(extractPlanJson(out).trim()).toBe('{"chunks":[]}');
  });

  it("extracts the LAST fenced json block when multiple exist", () => {
    const out =
      '```json\n{"old":true}\n```\n\nrevision:\n\n```json\n{"final":true}\n```';
    expect(extractPlanJson(out).trim()).toBe('{"final":true}');
  });

  it("falls back to brace slice when no fence present", () => {
    const out = 'some text { "chunks": [] } trailing';
    expect(extractPlanJson(out).trim()).toBe('{ "chunks": [] }');
  });

  it("throws when no JSON can be found", () => {
    expect(() => extractPlanJson("no json here at all")).toThrow(/no JSON/);
  });
});

describe("plan: validatePlan", () => {
  const parentRepos = ["cos", "gp-api"];

  it("accepts a valid linear DAG", () => {
    const plan: Plan = {
      chunks: [
        {
          key: "a",
          title: "A",
          description: "d",
          acceptance_criteria: "c",
          repos: ["cos"],
          priority: 2,
          depends_on_keys: [],
        },
        {
          key: "b",
          title: "B",
          description: "d",
          acceptance_criteria: "c",
          repos: ["gp-api"],
          priority: 2,
          depends_on_keys: ["a"],
        },
      ],
    };
    expect(validatePlan(plan, parentRepos).errors).toEqual([]);
  });

  it("rejects self-dependency", () => {
    const plan: Plan = {
      chunks: [
        {
          key: "a",
          title: "A",
          description: "d",
          acceptance_criteria: "c",
          repos: ["cos"],
          priority: 2,
          depends_on_keys: ["a"],
        },
      ],
    };
    const { errors } = validatePlan(plan, parentRepos);
    expect(errors.some((e) => e.includes("itself"))).toBe(true);
  });

  it("rejects cycles", () => {
    const plan: Plan = {
      chunks: [
        {
          key: "a",
          title: "A",
          description: "d",
          acceptance_criteria: "c",
          repos: ["cos"],
          priority: 2,
          depends_on_keys: ["b"],
        },
        {
          key: "b",
          title: "B",
          description: "d",
          acceptance_criteria: "c",
          repos: ["cos"],
          priority: 2,
          depends_on_keys: ["a"],
        },
      ],
    };
    const { errors } = validatePlan(plan, parentRepos);
    expect(errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("rejects unknown dep keys", () => {
    const plan: Plan = {
      chunks: [
        {
          key: "a",
          title: "A",
          description: "d",
          acceptance_criteria: "c",
          repos: ["cos"],
          priority: 2,
          depends_on_keys: ["ghost"],
        },
      ],
    };
    const { errors } = validatePlan(plan, parentRepos);
    expect(errors.some((e) => e.includes("unknown key"))).toBe(true);
  });

  it("rejects repos outside the parent's repo set", () => {
    const plan: Plan = {
      chunks: [
        {
          key: "a",
          title: "A",
          description: "d",
          acceptance_criteria: "c",
          repos: ["people-api"],
          priority: 2,
          depends_on_keys: [],
        },
      ],
    };
    const { errors } = validatePlan(plan, parentRepos);
    expect(errors.some((e) => e.includes("not in parent repos"))).toBe(true);
  });
});

describe("plan: cmdPlan (--from-file)", () => {
  it("creates children, wires deps, clears needs_planning, sets parent.depends_on", () => {
    const parentId = insertParent();
    const planFile = join(tmp, "plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        chunks: [
          {
            key: "schema",
            title: "Add schema columns",
            description: "Add parent_id + needs_planning",
            acceptance_criteria: "Columns present; migration idempotent.",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: [],
          },
          {
            key: "command",
            title: "Add cos plan command",
            description: "Wire the planning command",
            acceptance_criteria: "Command exists and decomposes.",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: ["schema"],
          },
          {
            key: "api-consumer",
            title: "Make gp-api read new column",
            description: "Read the new planning flag from the DB.",
            acceptance_criteria: "API exposes the flag.",
            repos: ["gp-api"],
            priority: 2,
            depends_on_keys: ["schema"],
          },
        ],
        notes: "Parallel tail after schema.",
      }),
    );

    cmdPlan(parentId, { fromFile: planFile });

    const children = workItems.listChildren(parentId);
    expect(children).toHaveLength(3);

    const parent = workItems.get(parentId)!;
    expect(parent.needs_planning).toBe(false);
    expect(parent.depends_on).toHaveLength(3);
    expect(parent.depends_on.sort()).toEqual(children.map((c) => c.id).sort());

    const byTitle = Object.fromEntries(children.map((c) => [c.title, c]));
    const schema = byTitle["Add schema columns"];
    const cmd = byTitle["Add cos plan command"];
    const apic = byTitle["Make gp-api read new column"];
    expect(schema.depends_on).toEqual([]);
    expect(cmd.depends_on).toEqual([schema.id]);
    expect(apic.depends_on).toEqual([schema.id]);
    expect(schema.parent_id).toBe(parentId);
    expect(cmd.parent_id).toBe(parentId);
    expect(apic.source).toMatch(/^plan:/);
  });

  it("refuses to re-plan without --replan", () => {
    const parentId = insertParent();
    const planFile = join(tmp, "plan2.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        chunks: [
          {
            key: "only",
            title: "Only chunk",
            description: "d",
            acceptance_criteria: "c",
            repos: ["cos"],
            priority: 3,
            depends_on_keys: [],
          },
        ],
      }),
    );
    cmdPlan(parentId, { fromFile: planFile });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    try {
      expect(() => cmdPlan(parentId, { fromFile: planFile })).toThrow(/exit 3/);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

describe("doctor: planned-parent-rollup invariant", () => {
  it("marks parent done once all children are merged", () => {
    const parentId = insertParent();
    const planFile = join(tmp, "plan3.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        chunks: [
          {
            key: "one",
            title: "One",
            description: "d",
            acceptance_criteria: "c",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: [],
          },
          {
            key: "two",
            title: "Two",
            description: "d",
            acceptance_criteria: "c",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: ["one"],
          },
        ],
      }),
    );
    cmdPlan(parentId, { fromFile: planFile });

    const [c1, c2] = workItems.listChildren(parentId);
    workItems.update(c1.id, { status: "merged" });
    workItems.update(c2.id, { status: "merged" });

    const report = runDoctor({ autoFix: true, dryRun: false, format: "json" });
    const finding = report.findings.find(
      (f) => f.invariant === "planned-parent-rollup",
    );
    expect(finding).toBeDefined();
    expect(finding!.ok).toBe(false);
    expect(finding!.fixed.some((x) => x.id === parentId)).toBe(true);

    const parent = workItems.get(parentId)!;
    expect(parent.status).toBe("done");
    expect(parent.completed_at).toBeTruthy();
  });

  it("leaves parent alone while any child is still open", () => {
    const parentId = insertParent();
    const planFile = join(tmp, "plan4.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        chunks: [
          {
            key: "one",
            title: "One",
            description: "d",
            acceptance_criteria: "c",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: [],
          },
          {
            key: "two",
            title: "Two",
            description: "d",
            acceptance_criteria: "c",
            repos: ["cos"],
            priority: 2,
            depends_on_keys: [],
          },
        ],
      }),
    );
    cmdPlan(parentId, { fromFile: planFile });

    const [c1, c2] = workItems.listChildren(parentId);
    workItems.update(c1.id, { status: "merged" });
    // c2 still queued

    runDoctor({ autoFix: true, dryRun: false, format: "json" });

    const parent = workItems.get(parentId)!;
    expect(parent.status).not.toBe("done");
    // Avoid lint about unused vars when c2 isn't referenced in asserts:
    expect(c2.status).toBe("queued");
  });
});
