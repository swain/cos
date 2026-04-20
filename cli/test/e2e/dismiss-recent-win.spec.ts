import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("dismiss on a recent-win inside the FYI expander removes only that row", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  const ids: string[] = [];
  try {
    clearAll(db);
    for (const title of ["win-A", "win-B", "win-C"]) {
      ids.push(seedWorkItem(db, { title, status: "merged" }));
    }
  } finally {
    db.close();
  }

  await page.goto("/");

  // Recent wins live inside a <details> expander in FYI — open it first.
  const disclosure = page.locator("#recent-wins");
  await expect(disclosure).toBeVisible();
  await disclosure.locator("summary").click();

  const rowSelectors = ids.map(
    (id) => `#row-recent-win\\:${id.replace(/:/g, "\\:")}`,
  );
  for (const sel of rowSelectors) await expect(page.locator(sel)).toBeVisible();

  const middle = page.locator(rowSelectors[1]);
  await middle.locator('form[action$="/pr-reviewed"] button').click();

  // The dismissed row is gone from the server response entirely.
  await expect(page.locator(rowSelectors[1])).toHaveCount(0);
  // The siblings are still rendered by the server (just inside a collapsed
  // <details> after the redirect re-rendered the page).
  await expect(page.locator(rowSelectors[0])).toHaveCount(1);
  await expect(page.locator(rowSelectors[2])).toHaveCount(1);
});
