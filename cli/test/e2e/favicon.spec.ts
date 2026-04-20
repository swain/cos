import { test, expect } from "@playwright/test";

test("GET /favicon.svg serves the Po mark with correct content-type", async ({
  request,
}) => {
  const res = await request.get("/favicon.svg");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("image/svg+xml");
  const body = await res.text();
  expect(body).toMatch(/^<svg/);
  expect(body).toContain("po-mark__bg");
  expect(body).toContain("po-mark__glyph");
  // Self-contained colors — tab chrome has no access to page CSS, so the
  // favicon must embed its own fills via a <style> block.
  expect(body).toContain("prefers-color-scheme");
});

test("dashboard HTML links the favicon", async ({ page }) => {
  await page.goto("/");
  const link = page.locator('link[rel="icon"]');
  await expect(link).toHaveAttribute("type", "image/svg+xml");
  await expect(link).toHaveAttribute("href", "/favicon.svg");
});
