import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedNotification } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test.use({ javaScriptEnabled: false });

test("page still renders and ack works with JavaScript disabled", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let id: string;
  try {
    clearAll(db);
    id = seedNotification(db, {
      subject: "ack-me-no-js",
      body: "fyi body",
      urgency: "normal",
    });
  } finally {
    db.close();
  }

  await page.goto("/");
  await expect(page).toHaveTitle(/^Inbox \(\d+\)$/);

  const rowSel = `#row-notification\\:${id}`;
  await expect(page.locator(rowSel)).toBeVisible();

  await page.locator(rowSel).locator('form[action$="/ack"] button').click();

  await page.waitForLoadState("load");
  await expect(page.locator(rowSel)).toHaveCount(0);
});
