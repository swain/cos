import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_DB_PATH, E2E_PORT } from "./test/helpers/env.js";

process.env.COS_E2E_DB_PATH = E2E_DB_PATH;
process.env.COS_E2E_PORT = String(E2E_PORT);

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 15_000,
  expect: { timeout: 5_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? "list" : [["list"]],
  globalSetup: "./test/global-setup.ts",
  use: {
    baseURL: E2E_BASE_URL,
  },
});
