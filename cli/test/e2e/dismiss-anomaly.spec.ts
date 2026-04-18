import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedSession } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("dismiss on an anomaly session removes only that row", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  const ids: string[] = [];
  try {
    clearAll(db);
    for (let i = 0; i < 3; i++) {
      ids.push(
        seedSession(db, {
          status: "failed",
          current_step: "editing",
          notes: `boom-${i}`,
        }),
      );
    }
  } finally {
    db.close();
  }

  await page.goto("/");

  const rowSelectors = ids.map(
    (id) => `#row-session\\:${id.replace(/:/g, "\\:")}`,
  );
  for (const sel of rowSelectors) await expect(page.locator(sel)).toBeVisible();

  const middle = page.locator(rowSelectors[1]);
  await middle.locator('form[action$="/dismiss"] button').click();

  await expect(page.locator(rowSelectors[1])).toHaveCount(0);
  await expect(page.locator(rowSelectors[0])).toBeVisible();
  await expect(page.locator(rowSelectors[2])).toBeVisible();
});
