# Worked example: `cos plan` decomposition for a realistic multi-repo feature

This is the output of `cos plan` on a hypothetical parent work item that spans three repos. It illustrates what a healthy decomposition looks like: small-ish chunks, each one PR-shaped, explicit deps, minimal over-sequencing.

## Parent work item

```json
{
  "id": "wi-EXAMPLE-PARENT",
  "title": "Impersonation audit trail — record and surface who-acted-as-whom",
  "description": "Today we cannot answer 'did an admin actually take this action, or was it the user themselves?' for impersonated sessions. Record the real actor on every write, expose it in the admin UI, and backfill the last 90 days from request logs where possible.",
  "acceptance_criteria": "1) Every write in gp-api tags audit rows with impersonator_user_id when applicable. 2) Admin UI in gp-webapp surfaces 'acted as <user> by <admin>' for any row with impersonator_user_id. 3) Backfill job populates impersonator_user_id for the last 90 days using request-log data from people-api. 4) Integration test asserts an impersonated create shows the correct actor in the UI.",
  "repos": ["gp-api", "gp-webapp", "people-api"],
  "priority": 2,
  "source": "user",
  "needs_planning": true
}
```

## Plan emitted by the planner subagent

```json
{
  "chunks": [
    {
      "key": "schema",
      "title": "Add impersonator_user_id column to audit_log (gp-api)",
      "description": "Schema migration + Prisma regen + contracts export. No callers read it yet. Backfills column as NULL; no default, no required writes.",
      "acceptance_criteria": "1) Prisma migration adds nullable impersonator_user_id to audit_log. 2) contracts package exports the updated AuditLog type. 3) `npm run verify` green.",
      "repos": ["gp-api"],
      "priority": 2,
      "depends_on_keys": []
    },
    {
      "key": "writer",
      "title": "Populate impersonator_user_id on every audit_log write (gp-api)",
      "description": "Update the audit service to read req.session.impersonator_user_id (already set by the middleware) and pass it through to every audit_log insert. Feature-flagged off is NOT needed — null behaves as today.",
      "acceptance_criteria": "1) Unit tests cover impersonated + non-impersonated writes. 2) E2E test shows real admin user id in the column after an impersonated action.",
      "repos": ["gp-api"],
      "priority": 2,
      "depends_on_keys": ["schema"]
    },
    {
      "key": "people-log-ingest",
      "title": "Expose impersonator lookup endpoint on people-api",
      "description": "Backfill needs to map request IDs to impersonator_user_id via the request-log table. Expose an S2S endpoint that takes request-ids and returns that map. Purely additive.",
      "acceptance_criteria": "1) New POST /internal/request-log/impersonators endpoint behind S2S JWT. 2) Returns {requestId: impersonatorUserId|null} for up to 1000 requests/call. 3) Integration test covers both impersonated and non-impersonated request ids.",
      "repos": ["people-api"],
      "priority": 2,
      "depends_on_keys": []
    },
    {
      "key": "backfill",
      "title": "Backfill 90 days of impersonator_user_id (gp-api)",
      "description": "One-shot script that joins audit_log against people-api's new endpoint in batches of 1000 and updates in place. Idempotent: only updates where column is NULL.",
      "acceptance_criteria": "1) Script dry-run reports row counts. 2) Run against dev DB; spot-check 20 rows manually. 3) Locks/WAL not required for the batch size.",
      "repos": ["gp-api"],
      "priority": 3,
      "depends_on_keys": ["writer", "people-log-ingest"]
    },
    {
      "key": "ui",
      "title": "Surface 'acted as <user> by <admin>' in admin audit view (gp-webapp)",
      "description": "Audit log table in the admin UI renders the impersonator when present. New column title 'Actor' replaces 'User'; uses existing admin name-lookup hook.",
      "acceptance_criteria": "1) Story in Storybook covers impersonated + non-impersonated rows. 2) Column is sortable. 3) Cypress E2E: impersonated action shows correct admin name in the audit table within 30s of the action.",
      "repos": ["gp-webapp"],
      "priority": 2,
      "depends_on_keys": ["writer"]
    }
  ],
  "notes": "Schema first. Writer and people-log-ingest run in parallel after schema. UI and backfill are the only two that wait on the writer so the column has real data before the UI tries to render it."
}
```

## Resulting dependency graph

```
        ┌──────────┐
        │  schema  │                       ┌─────────────────────┐
        └────┬─────┘                       │ people-log-ingest   │
             │                             └────────────┬────────┘
             ▼                                          │
        ┌──────────┐                                    │
        │  writer  │                                    │
        └────┬─────┘                                    │
     ┌───────┴───────┐                                  │
     ▼               ▼                                  │
┌─────────┐    ┌──────────┐                             │
│   ui    │    │ backfill │◄────────────────────────────┘
└─────────┘    └──────────┘
```

- Schema has no deps → runs first.
- `writer` and `people-log-ingest` run in parallel after `schema` and nothing, respectively.
- `ui` only waits on `writer`.
- `backfill` waits on both `writer` (column populated) and `people-log-ingest` (lookup available).

## How this lands

1. `cos plan wi-EXAMPLE-PARENT` writes 5 child work items with `parent_id=wi-EXAMPLE-PARENT` and each child's `depends_on` wired to the resolved `wi-*` ids of its dep keys.
2. Parent's `depends_on` is set to **all** child ids; parent's `needs_planning` flipped to `0`.
3. Next `cos tick`:
   - Dispatches `schema` and `people-log-ingest` in parallel (no deps).
   - Leaves `writer`, `ui`, `backfill` blocked (dispatch gate refuses while deps aren't merged).
4. As each PR merges, doctor's `pr-status-drift` reconciles the child to `merged`; subsequent ticks dispatch whatever is newly unblocked.
5. When all 5 children reach `merged`/`done`, doctor's `planned-parent-rollup` flips the parent to `done` and sets `completed_at`.

## What makes this a good plan (vs common failure modes)

- **Chunks are PR-shaped, not task-shaped.** No "write tests" or "update docs" chunks — tests + docs ride with the code that needs them.
- **The UI doesn't depend on the backfill.** Historical rows simply render with no impersonator until backfill catches up. Over-sequencing them would block UI behind a slow script for no reason.
- **people-log-ingest is its own chunk.** It's in a different repo with a different reviewer and ships independently; bundling it into `backfill` would create a cross-repo PR that can't be reviewed coherently.
- **Only one chunk per parallel branch needs the other.** `backfill` is the synchronization point. Keeping the graph shallow makes the dispatch tick's decisions trivial.
