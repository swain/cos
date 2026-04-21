import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    env: {
      // Skip gws spawn in every vitest run — otherwise tests hitting
      // collectDashboard() leak into the live calendar on a dev machine with
      // Google Workspace auth, and fail in CI where gws is absent.
      COS_DISABLE_UPCOMING: "1",
    },
  },
});
