import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("Po icon is visible in header and opens the bio dialog", async ({
  page,
}) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
  } finally {
    db.close();
  }

  await page.goto("/");

  const mark = page.locator("#po-mark-btn");
  await expect(mark).toBeVisible();
  await expect(mark).toHaveAttribute("aria-label", "About Po");
  await expect(mark.locator("svg")).toBeVisible();

  const dialog = page.locator("#po-dialog");
  await expect(dialog).toBeAttached();
  await expect(dialog).not.toBeVisible();

  await mark.click();
  await expect(dialog).toBeVisible();
  // Assert on the dialog chrome (always rendered) rather than bio content —
  // CI doesn't ship ~/.claude/cos/po.md, so the body falls back to a stub.
  await expect(dialog.locator(".po-dialog__title")).toHaveText("About Po");
  await expect(dialog.locator(".po-dialog__body")).not.toBeEmpty();

  await dialog.locator(".po-dialog__close").click();
  await expect(dialog).not.toBeVisible();
});
