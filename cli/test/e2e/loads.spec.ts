import { test, expect } from "@playwright/test";
import {
  clearAll,
  openSeedDb,
  seedNotification,
  seedWorkItem,
} from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("home page renders 200, titled, two top-level sections", async ({
  page,
  request,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    // Seed a blocked row (Review) + an FYI notification so both sections render.
    seedWorkItem(db, {
      title: "blocked thing",
      status: "blocked",
      needs_approval: false,
    });
    seedNotification(db, {
      subject: "fyi hello",
      body: "ignore me",
      urgency: "normal",
    });
  } finally {
    db.close();
  }

  const res = await request.get("/");
  expect(res.status()).toBe(200);

  await page.goto("/");
  await expect(page).toHaveTitle(/^Inbox \(\d+\)$/);

  await expect(page.locator("#section-review")).toBeVisible();
  await expect(page.locator("#section-fyi")).toBeVisible();

  // The old sections must not exist.
  for (const id of [
    "section-needsDecision",
    "section-active",
    "section-queue",
    "section-ideas",
    "section-recentWins",
    "section-anomalies",
    "section-digest",
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }
});
