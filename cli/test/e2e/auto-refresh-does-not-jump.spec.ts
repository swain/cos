import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test.use({ viewport: { width: 1024, height: 600 } });

test("auto-refresh does not reset scroll position", async ({ page }) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    for (let i = 0; i < 12; i++) {
      seedWorkItem(db, { title: `queued-refresh-${i}`, status: "queued" });
    }
  } finally {
    db.close();
  }

  await page.goto("/");
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const scrollBefore = await page.evaluate(() => window.scrollY);
  expect(scrollBefore).toBeGreaterThan(100);

  await page.waitForResponse(
    (res) =>
      res.url().endsWith("/") &&
      res.request().method() === "GET" &&
      res.status() === 200,
    { timeout: 8_000 },
  );

  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(50);
});
