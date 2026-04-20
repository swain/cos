import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedNotification } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

// If a form action triggers a full document navigation, the page fires a
// `framenavigated` event on the main frame. We count those: the only
// acceptable navigation during this test is the initial `goto('/')`.
test("action submit does not trigger a full document navigation", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  let id: string;
  try {
    clearAll(db);
    id = seedNotification(db, {
      subject: "no-nav-ack",
      body: "fyi body",
      urgency: "normal",
    });
  } finally {
    db.close();
  }

  let navCount = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navCount += 1;
  });

  await page.goto("/");
  const navsAfterGoto = navCount;

  const rowSel = `#row-notification\\:${id}`;
  await expect(page.locator(rowSel)).toBeVisible();
  await page.locator(rowSel).locator('form[action$="/ack"] button').click();

  await expect(page.locator(rowSel)).toHaveCount(0);

  // A brief settle window so a late, unexpected navigation would still count.
  await page.waitForTimeout(200);

  expect(navCount).toBe(navsAfterGoto);
});
