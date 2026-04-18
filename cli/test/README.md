# Inbox web UI — integration tests

Playwright end-to-end tests for `cos inbox-serve`. They exist because PR #15
and PR #37 both shipped with live bugs that a smoke test would have caught —
rows whose dismiss action silently did nothing, scrollY jumping to top on every
click. The unit tests under `src/inbox/data.test.ts` cover the data layer; this
suite covers the rendered HTML + form submits.

## Run locally

```sh
cd cli
npm install          # first run only
npx playwright install chromium   # first run only
npm run test:e2e
```

`pretest:e2e` rebuilds `dist/` via `tsup`, so you don't need to `npm run build`
first. The suite completes in ~7s on a cold run.

To debug a single spec:

```sh
npx playwright test dismiss-recent-win --headed
npx playwright test --ui            # time-travel debugger
```

## How it works

- `playwright.config.ts` runs in a single worker, points at
  `http://127.0.0.1:$COS_E2E_PORT` (default 4412).
- `test/global-setup.ts` spawns one `inbox-serve` process via
  `test/helpers/bootInbox.ts`, pointed at a temp SQLite file
  (`$COS_E2E_DB_PATH`). The process is reused across all specs and torn down
  after the run.
- Each spec opens its own `better-sqlite3` handle to the same DB, clears all
  tables via `clearAll()`, and seeds the rows it needs through raw SQL helpers
  in `test/helpers/seed.ts` — intentionally not going through the CLI to keep
  tests fast and isolated from CLI behavior.
- The running `inbox-serve` reads the seed rows on the next GET `/`, so tests
  just navigate and assert.

## Adding a new scenario

1. Create `test/e2e/<name>.spec.ts`.
2. Open the DB, `clearAll`, seed via the helpers (or raw SQL for table shapes
   not covered by a helper).
3. `await page.goto("/")`, drive the UI, assert.

Minimal template:

```ts
import { test, expect } from "@playwright/test";
import { clearAll, openSeedDb, seedWorkItem } from "../helpers/seed.js";
import { E2E_DB_PATH } from "../helpers/env.js";

test("new scenario", async ({ page }) => {
  const db = openSeedDb(E2E_DB_PATH);
  try {
    clearAll(db);
    seedWorkItem(db, { title: "hi", status: "queued" });
  } finally {
    db.close();
  }
  await page.goto("/");
  await expect(page.getByText("hi")).toBeVisible();
});
```

## CI

`.github/workflows/inbox-tests.yml` runs this suite on every PR that touches
the inbox code, `cli/src/db.ts`, the schema, or the test files themselves. PRs
cannot merge if the suite fails.
