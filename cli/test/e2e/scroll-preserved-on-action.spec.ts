import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test.use({ viewport: { width: 1024, height: 600 } });

test("clicking an action preserves scroll position (does not jump to top)", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  const ids: string[] = [];
  try {
    clearAll(db);
    for (let i = 0; i < 10; i++) {
      ids.push(
        seedWorkItem(db, { title: `queued-thing-${i}`, status: "queued" }),
      );
    }
  } finally {
    db.close();
  }

  await page.goto("/");

  const targetIdx = 6;
  const targetSel = `#row-queue-item\\:${ids[targetIdx]}`;
  await page.locator(targetSel).scrollIntoViewIfNeeded();
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(100);

  await page
    .locator(targetSel)
    .locator('form[action$="/archive"] button')
    .click();

  await expect(page.locator(targetSel)).toHaveCount(0);

  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(scrollAfter).toBeGreaterThan(100);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(250);
});
