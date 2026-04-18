import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedNotification } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("ack on an FYI notification removes it from the page", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let id: string;
  try {
    clearAll(db);
    id = seedNotification(db, {
      subject: "ack me",
      body: "fyi body",
      urgency: "normal",
    });
  } finally {
    db.close();
  }

  await page.goto("/");
  const rowSel = `#row-notification\\:${id}`;
  await expect(page.locator(rowSel)).toBeVisible();

  await page.locator(rowSel).locator('form[action$="/ack"] button').click();

  await expect(page.locator(rowSel)).toHaveCount(0);
});
