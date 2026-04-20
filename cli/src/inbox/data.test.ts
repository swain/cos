import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ulid } from "ulid";

const tmp = mkdtempSync(join(tmpdir(), "cos-inbox-data-test-"));
process.env.COS_DB_PATH = join(tmp, "fleet.db");

import {
  collectDashboard,
  collectIdeasStats,
  UPCOMING_EMPTY_QUIPS,
} from "./data.js";
import {
  acceptAllSuggestKill,
  acceptIdea,
  deferIdea,
  killIdea,
  markPrReviewed,
  promoteIdea,
  dismissSession,
} from "./actions.js";
import { getDb, ideas, workItems, sessions } from "../db.js";
import type { TriageVerdict } from "../types.js";

afterAll(() => {
  getDb().close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  const db = getDb();
  db.exec(
    "DELETE FROM work_items; DELETE FROM sessions; DELETE FROM notifications; DELETE FROM cos_log; DELETE FROM ideas;",
  );
});

const insertScoredIdea = (
  overrides: Partial<{
    title: string;
    description: string;
    verdict: TriageVerdict;
    rationale: string;
    score: number;
    confidence: number;
    repos: string[];
    status: string;
  }> = {},
) => {
  const id = `idea-${ulid()}`;
  ideas.insert({
    id,
    title: overrides.title ?? "an idea",
    description: overrides.description ?? "desc",
    source: "test",
    confidence: overrides.confidence ?? 0.6,
    repos_guess: overrides.repos ?? ["cos"],
    status: (overrides.status as any) ?? "new",
    promoted_to: null,
  });
  if (overrides.verdict) {
    ideas.updateTriage(id, {
      verdict: overrides.verdict,
      rationale: overrides.rationale ?? "r",
      score: overrides.score ?? 0.5,
    });
  }
  return id;
};

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

describe("recentWinItems respects inbox_acked_at", () => {
  it("includes a freshly merged work item", () => {
    const id = insertWi({ title: "a merged win", status: "merged" });
    const d = collectDashboard();
    expect(d.recentWins.some((i) => i.id === id)).toBe(true);
  });

  it("hides a merged work item after dismiss (markPrReviewed)", async () => {
    const id = insertWi({ title: "dismiss me", status: "merged" });
    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(true);

    const r = await markPrReviewed(id);
    expect(r.ok).toBe(true);

    const after = collectDashboard();
    expect(after.recentWins.some((i) => i.id === id)).toBe(false);
  });

  it("hides a done work item after dismiss (markPrReviewed)", async () => {
    const id = insertWi({ title: "done and dismissed", status: "done" });
    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(true);

    await markPrReviewed(id);

    expect(collectDashboard().recentWins.some((i) => i.id === id)).toBe(false);
  });
});

describe("fyi section — anomalies fold in and respect acked_at", () => {
  it("hides a failed session after dismiss", async () => {
    const sessId = `sess-${ulid()}`;
    sessions.insert({
      id: sessId,
      work_item_id: null,
      tmux_window: null,
      kind: "worker",
      status: "failed",
      current_step: "editing",
      notes: "boom",
    });

    expect(collectDashboard().fyi.some((i) => i.id === sessId)).toBe(true);

    await dismissSession(sessId);

    expect(collectDashboard().fyi.some((i) => i.id === sessId)).toBe(false);
  });
});

describe("review section — ideas verdict + blocked + pr-open", () => {
  it("includes your-call ideas but excludes suggest-* ideas", () => {
    const yourCall = insertScoredIdea({
      title: "judge me",
      verdict: "your-call",
      score: 0.5,
    });
    const promote = insertScoredIdea({
      title: "promote-me",
      verdict: "suggest-promote",
      score: 0.9,
    });
    const kill = insertScoredIdea({
      title: "kill-me",
      verdict: "suggest-kill",
      score: 0.8,
    });

    const d = collectDashboard();
    expect(d.review.some((i) => i.id === yourCall)).toBe(true);
    expect(d.review.some((i) => i.id === promote)).toBe(false);
    expect(d.review.some((i) => i.id === kill)).toBe(false);
    expect(d.triagedIdeasCount).toBe(2);
  });

  it("includes blocked work items in review", () => {
    const id = insertWi({ title: "blocked one", status: "blocked" });
    expect(
      collectDashboard().review.some(
        (i) => i.id === id && i.kind === "blocked-item",
      ),
    ).toBe(true);
  });
});

describe("upcoming empty state — synthetic Po signoff card", () => {
  it("injects an upcoming-empty item when review has content and calendar is empty", () => {
    insertWi({ title: "blocked one", status: "blocked" });
    const d = collectDashboard();
    expect(d.upcoming).toHaveLength(1);
    expect(d.upcoming[0].kind).toBe("upcoming-empty");
    expect(UPCOMING_EMPTY_QUIPS).toContain(d.upcoming[0].subject);
  });

  it("does not inject when nothing else has content (zero-state covers it)", () => {
    expect(collectDashboard().upcoming).toHaveLength(0);
  });

  it("has at least 10 quips, all ≤100 chars, no emoji / exclamation", () => {
    expect(UPCOMING_EMPTY_QUIPS.length).toBeGreaterThanOrEqual(10);
    for (const q of UPCOMING_EMPTY_QUIPS) {
      expect(q.length).toBeLessThanOrEqual(100);
      expect(q).not.toMatch(/!/);
      expect(q).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe("ideas stats (browse count)", () => {
  it("reports scored + unscored totals", () => {
    insertScoredIdea({ verdict: "suggest-promote", score: 0.8 });
    insertScoredIdea();
    insertScoredIdea();
    const stats = collectIdeasStats();
    expect(stats.scoredTotal).toBe(1);
    expect(stats.unscoredTotal).toBe(2);
  });
});

describe("idea actions", () => {
  it("acceptIdea promotes a suggest-promote idea to a queued work item", async () => {
    const id = insertScoredIdea({
      title: "promote me",
      verdict: "suggest-promote",
      score: 0.9,
    });
    // suggest-promote does NOT surface in review, but accept still works.
    const r = await acceptIdea(id);
    expect(r.ok).toBe(true);

    const idea = ideas.get(id);
    expect(idea?.status).toBe("promoted");
    expect(idea?.promoted_to).toBeTruthy();
    const wi = workItems.get(idea!.promoted_to!);
    expect(wi?.status).toBe("queued");
  });

  it("acceptIdea kills a suggest-kill idea", async () => {
    const id = insertScoredIdea({
      title: "kill me",
      verdict: "suggest-kill",
      score: 0.8,
    });
    const r = await acceptIdea(id);
    expect(r.ok).toBe(true);
    expect(ideas.get(id)?.status).toBe("killed");
  });

  it("acceptIdea refuses your-call verdict", async () => {
    const id = insertScoredIdea({
      title: "judge me",
      verdict: "your-call",
    });
    const r = await acceptIdea(id);
    expect(r.ok).toBe(false);
    expect(ideas.get(id)?.status).toBe("new");
  });

  it("promoteIdea / killIdea / deferIdea transition status correctly", async () => {
    const a = insertScoredIdea({ title: "a", verdict: "your-call" });
    const b = insertScoredIdea({ title: "b", verdict: "your-call" });
    const c = insertScoredIdea({ title: "c", verdict: "your-call" });

    expect((await promoteIdea(a)).ok).toBe(true);
    expect(ideas.get(a)?.status).toBe("promoted");

    expect((await killIdea(b)).ok).toBe(true);
    expect(ideas.get(b)?.status).toBe("killed");

    expect((await deferIdea(c)).ok).toBe(true);
    expect(ideas.get(c)?.status).toBe("deferred");
  });

  it("acceptAllSuggestKill is a two-step confirm (still works even though UI hides suggest-* rows)", async () => {
    insertScoredIdea({ verdict: "suggest-kill", score: 0.8 });
    insertScoredIdea({ verdict: "suggest-kill", score: 0.7 });
    insertScoredIdea({ verdict: "suggest-promote", score: 0.8 });

    const first = await acceptAllSuggestKill(false);
    expect(first.ok).toBe(false);
    expect(first.message).toMatch(/confirm/);
    expect(ideas.list({ status: "killed" })).toHaveLength(0);

    const second = await acceptAllSuggestKill(true);
    expect(second.ok).toBe(true);
    expect(ideas.list({ status: "killed" })).toHaveLength(2);
    expect(ideas.list({ status: "new" })).toHaveLength(1);
  });
});
