import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { clearAll, openSeedDb, seedIdea } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

const ideaRowSelector = (id: string) =>
  `#row-idea\\:${id.replace(/:/g, "\\:")}`;

test("IDEAS section renders verdict + rationale + actions for scored ideas", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let promoteId = "";
  let killId = "";
  try {
    clearAll(db);
    promoteId = seedIdea(db, {
      title: "speedy win",
      triage_verdict: "suggest-promote",
      triage_rationale: "cheap, high ROI",
      triage_score: 0.9,
      confidence: 0.8,
    });
    killId = seedIdea(db, {
      title: "stale thing",
      triage_verdict: "suggest-kill",
      triage_rationale: "already done",
      triage_score: 0.8,
    });
    // An unscored idea — should NOT render but should show up in the
    // "+N still awaiting triage" line.
    seedIdea(db, { title: "not scored yet" });
  } finally {
    db.close();
  }

  await page.goto("/");

  const promoteRow = page.locator(ideaRowSelector(promoteId));
  await expect(promoteRow).toBeVisible();
  await expect(promoteRow.locator(".verdict.suggest-promote")).toBeVisible();
  await expect(promoteRow.locator(".text")).toContainText("cheap, high ROI");
  await expect(
    promoteRow.locator('form[action$="/promote"] button'),
  ).toBeVisible();
  await expect(
    promoteRow.locator('form[action$="/kill"] button'),
  ).toBeVisible();
  await expect(
    promoteRow.locator('form[action$="/defer"] button'),
  ).toBeVisible();
  await expect(
    promoteRow.locator('form[action$="/accept"] button'),
  ).toBeVisible();

  const killRow = page.locator(ideaRowSelector(killId));
  await expect(killRow.locator(".verdict.suggest-kill")).toBeVisible();

  // Unscored idea is not in the rendered list; the "awaiting triage" line is.
  await expect(page.locator("#section-ideas .ideas-more")).toContainText(
    "still awaiting triage",
  );
});

test("accept on a suggest-promote idea queues a work item and hides the row", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let ideaId = "";
  try {
    clearAll(db);
    ideaId = seedIdea(db, {
      title: "clear win to promote",
      triage_verdict: "suggest-promote",
      triage_rationale: "clear win",
      triage_score: 0.9,
    });
  } finally {
    db.close();
  }

  await page.goto("/");

  const row = page.locator(ideaRowSelector(ideaId));
  await expect(row).toBeVisible();

  await row.locator('form[action$="/accept"] button').click();

  await expect(page.locator(ideaRowSelector(ideaId))).toHaveCount(0);

  // DB should reflect the promotion.
  const verify = new Database(E2E_DB_PATH);
  try {
    const idea = verify
      .prepare(`SELECT status, promoted_to FROM ideas WHERE id = ?`)
      .get(ideaId) as { status: string; promoted_to: string | null };
    expect(idea.status).toBe("promoted");
    expect(idea.promoted_to).toBeTruthy();
    const wi = verify
      .prepare(`SELECT status FROM work_items WHERE id = ?`)
      .get(idea.promoted_to!) as { status: string };
    expect(wi.status).toBe("queued");
  } finally {
    verify.close();
  }
});

test("accept-all-suggest-kill requires a confirm submit", async ({ page }) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    seedIdea(db, {
      title: "kill 1",
      triage_verdict: "suggest-kill",
      triage_score: 0.8,
    });
    seedIdea(db, {
      title: "kill 2",
      triage_verdict: "suggest-kill",
      triage_score: 0.7,
    });
    seedIdea(db, {
      title: "spare",
      triage_verdict: "suggest-promote",
      triage_score: 0.8,
    });
  } finally {
    db.close();
  }

  await page.goto("/");
  const section = page.locator("#section-ideas");

  // First click arms the confirm state.
  await section
    .locator('form[action="/ideas/accept-all-suggest-kill"] button')
    .first()
    .click();
  await expect(section.locator(".confirm")).toBeVisible();

  // DB still has 2 suggest-kill items alive.
  const checkBefore = new Database(E2E_DB_PATH);
  try {
    const alive = checkBefore
      .prepare(`SELECT COUNT(*) AS n FROM ideas WHERE status = 'new'`)
      .get() as { n: number };
    expect(alive.n).toBe(3);
  } finally {
    checkBefore.close();
  }

  // Second click (the confirm form) actually kills them.
  await section
    .locator('form[action="/ideas/accept-all-suggest-kill"] button.danger')
    .click();

  const check = new Database(E2E_DB_PATH);
  try {
    const killed = check
      .prepare(`SELECT COUNT(*) AS n FROM ideas WHERE status = 'killed'`)
      .get() as { n: number };
    expect(killed.n).toBe(2);
    const aliveAfter = check
      .prepare(`SELECT COUNT(*) AS n FROM ideas WHERE status = 'new'`)
      .get() as { n: number };
    expect(aliveAfter.n).toBe(1);
  } finally {
    check.close();
  }
});
