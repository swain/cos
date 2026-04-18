import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("home page renders 200, titled, all 8 section classes present", async ({
  page,
  request,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    seedWorkItem(db, { title: "a queued thing", status: "queued" });
  } finally {
    db.close();
  }

  const res = await request.get("/");
  expect(res.status()).toBe(200);

  await page.goto("/");
  await expect(page).toHaveTitle(/^Inbox \(\d+\)$/);

  for (const id of [
    "section-needsDecision",
    "section-active",
    "section-queue",
    "section-ideas",
    "section-recentWins",
    "section-anomalies",
    "section-fyi",
    "section-digest",
  ]) {
    await expect(page.locator(`#${id}`)).toBeVisible();
  }
});
