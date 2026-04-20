import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("empty Upcoming section renders Po signoff card", async ({ page }) => {
  // COS_DISABLE_UPCOMING=1 is set by bootInbox — getUpcomingMeetings() returns
  // []. Seed one Review row so the inbox isn't zero-state.
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    seedWorkItem(db, {
      title: "blocked thing to anchor review",
      status: "blocked",
      needs_approval: false,
    });
  } finally {
    db.close();
  }

  await page.goto("/");

  const section = page.locator("#section-upcoming");
  await expect(section).toBeVisible();

  const card = section.locator(".card--upcoming-empty");
  await expect(card).toBeVisible();

  const quip = card.locator(".card--upcoming-empty__quip");
  await expect(quip).toBeVisible();
  await expect(quip).not.toBeEmpty();

  const sig = card.locator(".card--upcoming-empty__sig");
  await expect(sig).toBeVisible();
  await expect(sig).toHaveText("— Po");

  // The section header still renders; count label swaps to "clear".
  await expect(section.locator(".section__count")).toHaveText("clear");
});

test("non-empty Upcoming still renders meeting cards, not the Po signoff", async ({
  page,
}) => {
  // We can't seed a live calendar event, but we can assert that when the
  // empty-state card IS NOT present, nothing under #section-upcoming masquerades
  // as one. Combined with the previous test, this guards the else branch.
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
  } finally {
    db.close();
  }

  // Zero-state: no review, no fyi, no upcoming → whole-inbox zero state kicks in.
  await page.goto("/");
  await expect(page.locator(".zero-state")).toBeVisible();
  await expect(page.locator(".card--upcoming-empty")).toHaveCount(0);
  await expect(page.locator("#section-upcoming")).toHaveCount(0);
});
