import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { clearAll, openSeedDb, seedIdea } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

const ideaRowSelector = (id: string) =>
  `#row-idea\\:${id.replace(/:/g, "\\:")}`;

test("your-call ideas fold into Review; suggest-* hide behind a browse line", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let yourCallId = "";
  let promoteId = "";
  let killId = "";
  try {
    clearAll(db);
    yourCallId = seedIdea(db, {
      title: "judge this one",
      triage_verdict: "your-call",
      triage_rationale: "needs a call",
      triage_score: 0.5,
      confidence: 0.6,
    });
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
  } finally {
    db.close();
  }

  await page.goto("/");

  // your-call renders in Review with promote/kill/defer actions.
  const yourCallRow = page.locator(ideaRowSelector(yourCallId));
  await expect(yourCallRow).toBeVisible();
  await expect(
    yourCallRow.locator('form[action$="/promote"] button'),
  ).toBeVisible();
  await expect(
    yourCallRow.locator('form[action$="/kill"] button'),
  ).toBeVisible();
  await expect(
    yourCallRow.locator('form[action$="/defer"] button'),
  ).toBeVisible();

  // suggest-promote / suggest-kill are NOT on the page — they're collapsed into
  // a single "N triaged ideas" browse line in FYI.
  await expect(page.locator(ideaRowSelector(promoteId))).toHaveCount(0);
  await expect(page.locator(ideaRowSelector(killId))).toHaveCount(0);
  await expect(page.locator("#section-fyi .browse-line")).toContainText(
    "triaged ideas",
  );
});

test("promote on a your-call idea queues a work item and hides the row", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let ideaId = "";
  try {
    clearAll(db);
    ideaId = seedIdea(db, {
      title: "promote this",
      triage_verdict: "your-call",
      triage_rationale: "clear win",
      triage_score: 0.9,
    });
  } finally {
    db.close();
  }

  await page.goto("/");

  const row = page.locator(ideaRowSelector(ideaId));
  await expect(row).toBeVisible();

  await row.locator('form[action$="/promote"] button').click();

  await expect(page.locator(ideaRowSelector(ideaId))).toHaveCount(0);

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
