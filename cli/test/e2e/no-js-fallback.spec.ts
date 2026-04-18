import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test.use({ javaScriptEnabled: false });

test("page still renders and dismiss works with JavaScript disabled", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let id: string;
  try {
    clearAll(db);
    id = seedWorkItem(db, { title: "dismiss-me-no-js", status: "merged" });
  } finally {
    db.close();
  }

  await page.goto("/");
  await expect(page).toHaveTitle(/^Inbox \(\d+\)$/);

  const rowSel = `#row-recent-win\\:${id}`;
  await expect(page.locator(rowSel)).toBeVisible();

  await page
    .locator(rowSel)
    .locator('form[action$="/pr-reviewed"] button')
    .click();

  await page.waitForLoadState("load");
  await expect(page.locator(rowSel)).toHaveCount(0);
});
