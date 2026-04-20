import { ulid } from "ulid";
import chalk from "chalk";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import { workItems, sessions, kv, plans } from "../db.js";
import { buildPlanApprovedAddendum } from "./plans.js";
import type { WorkItem, SessionKind } from "../types.js";
import {
  COS_DIR,
  PROMPTS_DIR,
  WORKLOGS_DIR,
  CONFIG_JSON,
  WATCHED_REPOS_JSON,
  displayWorkItemId,
  parseJson,
  shortRepoName,
  tmuxWindowName,
  loadWatchedRepoBaseBranches,
} from "../util.js";

const HOME = homedir();

export const cmdSessionNew = (opts: {
  workItemId?: string;
  kind?: SessionKind;
  notes?: string;
}) => {
  const id = `sess-${ulid()}`;
  sessions.insert({
    id,
    work_item_id: opts.workItemId ?? null,
    tmux_window: null,
    kind: opts.kind ?? "worker",
    status: "starting",
    current_step: null,
    notes: opts.notes ?? null,
  });
  console.log(id);
  return id;
};

export const cmdWorkerDone = (
  sessionId: string,
  opts: { prUrl?: string; failed?: string },
) => {
  const s = sessions.get(sessionId);
  if (!s) {
    console.error(chalk.red(`session not found: ${sessionId}`));
    process.exit(2);
  }
  if (opts.prUrl) {
    sessions.update(sessionId, {
      status: "completed",
      current_step: "pr-opened",
      ended_at: new Date().toISOString(),
    });
    if (s.work_item_id) {
      const wi = workItems.get(s.work_item_id);
      if (wi) {
        const next = Array.from(new Set([...wi.pr_urls, opts.prUrl]));
        workItems.update(s.work_item_id, {
          status: "pr-open",
          pr_urls: next,
          session_id: null,
        });
      }
    }
    console.log(chalk.green("worker done"), sessionId, "→", opts.prUrl);
    return;
  }
  if (opts.failed) {
    // Idempotency: never clobber a completed session with failed. The safety-net
    // in spawn-worker fires unconditionally after claude -p exits; if the worker
    // already called --pr-url successfully, respect that and no-op.
    if (s.status === "completed") {
      console.log(
        chalk.gray("worker-done --failed ignored"),
        sessionId,
        "(already completed)",
      );
      return;
    }
    // Also no-op if already marked failed/killed, to keep the record idempotent.
    if (s.status === "failed" || s.status === "killed") {
      console.log(
        chalk.gray("worker-done --failed ignored"),
        sessionId,
        `(already ${s.status})`,
      );
      return;
    }
    sessions.update(sessionId, {
      status: "failed",
      current_step: "failed",
      notes: opts.failed,
      ended_at: new Date().toISOString(),
    });
    if (s.work_item_id) {
      // Mechanical exits (safety-net trap in spawn-worker fires when the shell
      // dies without the worker calling --pr-url) are not genuine blockers — the
      // WI should go straight back to queued for redispatch. Worker-reported
      // failures ("stuck >10min" etc.) stay blocked until a human looks.
      //
      // pr-open WIs keep their status regardless — the PR is still live on
      // GitHub, so the next pr-comments signal (or the invariant-4 tick
      // reconciliation) is the right re-entry point, not a blanket requeue.
      const wi = workItems.get(s.work_item_id);
      const isMechanicalExit = opts.failed.startsWith("worker shell exited");
      if (wi?.status === "pr-open") {
        workItems.update(s.work_item_id, { session_id: null });
      } else {
        workItems.update(s.work_item_id, {
          status: isMechanicalExit ? "queued" : "blocked",
          session_id: null,
        });
      }
    }
    console.log(chalk.red("worker failed"), sessionId, "—", opts.failed);
    return;
  }
  console.error(chalk.red("worker-done requires --pr-url or --failed"));
  process.exit(2);
};

const findRepoLocalPath = (remoteName: string): string | null => {
  const reposBase = join(HOME, "Repos");
  const shortName = shortRepoName(remoteName);
  // Check common locations
  const candidates = [
    join(reposBase, shortName),
    join(HOME, "Repos/thegoodparty", shortName),
  ];
  for (const c of candidates) if (existsSync(join(c, ".git"))) return c;
  return null;
};

const postSetupHook = (repoShort: string): string => {
  const tsRepos = [
    "gp-api",
    "gp-webapp",
    "people-api",
    "election-api",
    "ops",
    "serve-ops",
    "cos",
  ];
  if (tsRepos.includes(repoShort)) return "npm install --legacy-peer-deps";
  if (repoShort === "gp-ai-projects") return "uv sync";
  return ":";
};

export const cmdWorkerSetup = (workItemRef: string) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  const { defaultBaseBranch, baseBranchByShortName } =
    loadWatchedRepoBaseBranches(WATCHED_REPOS_JSON);
  const displayId = displayWorkItemId(wi);
  const branch = `cos/${displayId}`;
  const out: Record<string, string> = {};

  for (const repoRaw of wi.repos) {
    const short = shortRepoName(repoRaw);
    const baseBranch = baseBranchByShortName[short] ?? defaultBaseBranch;
    const repoPath = findRepoLocalPath(repoRaw);
    if (!repoPath) {
      console.error(
        chalk.yellow(
          `repo not found locally: ${repoRaw} (skipping worktree, worker will handle)`,
        ),
      );
      continue;
    }
    const wtBase = join(dirname(repoPath), `${short}-worktrees`);
    mkdirSync(wtBase, { recursive: true });
    const wtPath = join(wtBase, displayId);
    if (!existsSync(wtPath)) {
      try {
        execSync(`git -C "${repoPath}" fetch origin ${baseBranch}`, {
          stdio: "pipe",
        });
        execSync(
          `git -C "${repoPath}" worktree add "${wtPath}" -b "${branch}" origin/${baseBranch}`,
          { stdio: "pipe" },
        );
      } catch (e: any) {
        console.error(
          chalk.yellow(`worktree create failed for ${short}: ${e.message}`),
        );
      }
      const hook = postSetupHook(short);
      if (hook !== ":") {
        try {
          execSync(hook, { cwd: wtPath, stdio: "inherit" });
        } catch (e: any) {
          console.error(
            chalk.yellow(`post-setup hook failed for ${short}: ${e.message}`),
          );
        }
      }
    }
    out[repoRaw] = wtPath;
  }
  workItems.update(wi.id, { worktree_paths: out });
  console.log(JSON.stringify(out, null, 2));
};

const workerPromptTemplate = () => {
  const p = join(PROMPTS_DIR, "worker.md");
  return existsSync(p) ? readFileSync(p, "utf8") : FALLBACK_WORKER_PROMPT;
};

const FALLBACK_WORKER_PROMPT = `You are a COS worker running on work item {{WI_ID}} (session {{SESSION_ID}}).

{{MODE_ADDENDUM}}

Goal:
{{TITLE}}

{{DESCRIPTION}}

Acceptance criteria:
{{ACCEPTANCE}}

Worktrees (work in these directories):
{{WORKTREES}}

Rules:
1. Before changing any repo, read its CLAUDE.md (and ~/.claude/cos/arch.md).
2. Create a branch off latest develop named \`cos/{{WI_ID}}\`. Worktree command already created the branch.
3. Commit incrementally (one logical unit per commit, imperative subject lines).
4. Run tests + lint before opening any PR.
5. Do NOT self-approve. Open the PR with base=develop via \`gh pr create --base develop\`.
6. Sequential gating: do not open a second PR on this work item until the first merges.
7. Heartbeat at key transitions: \`~/.claude/cos/bin/cos heartbeat {{SESSION_ID}} --step <name>\`. Steps: started, branch-ready, tests-pass, pr-opened.
8. When PR is open, run: \`~/.claude/cos/bin/cos worker-done {{SESSION_ID}} --pr-url <url>\` and exit.
9. If stuck >10 min on any step, run \`~/.claude/cos/bin/cos worker-done {{SESSION_ID}} --failed "<reason>"\` and exit.
10. Write progress to the worklog at {{WORKLOG_PATH}} (goal, current step, notes).

Work item details (JSON):
{{WI_JSON}}

Begin now.`;

export const cmdWorkerPrompt = (workItemRef: string, sessionId: string) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  const displayId = displayWorkItemId(wi);
  const worklogPath = wi.worklog_path ?? join(WORKLOGS_DIR, `${displayId}.md`);
  if (!existsSync(worklogPath)) {
    writeFileSync(
      worklogPath,
      `# Worklog: ${wi.title}\n\n- work item: ${displayId}\n- session: ${sessionId}\n- repos: ${wi.repos.join(", ")}\n- priority: P${wi.priority}\n\n## Goal\n${wi.description}\n\n## Acceptance\n${wi.acceptance_criteria}\n\n## Progress\n- started ${new Date().toISOString()}\n`,
    );
    workItems.update(wi.id, { worklog_path: worklogPath });
  }
  const worktrees =
    Object.entries(wi.worktree_paths)
      .map(([r, p]) => `- ${r}: ${p}`)
      .join("\n") || "(none configured)";
  const template = workerPromptTemplate();
  const filled = template
    .replaceAll("{{WI_ID}}", displayId)
    .replaceAll("{{SESSION_ID}}", sessionId)
    .replaceAll("{{TITLE}}", wi.title)
    .replaceAll("{{DESCRIPTION}}", wi.description)
    .replaceAll("{{ACCEPTANCE}}", wi.acceptance_criteria)
    .replaceAll("{{WORKTREES}}", worktrees)
    .replaceAll("{{WORKLOG_PATH}}", worklogPath)
    .replaceAll("{{MODE_ADDENDUM}}", buildModeAddendum(wi, sessionId))
    .replaceAll("{{WI_JSON}}", JSON.stringify(wi, null, 2));
  process.stdout.write(filled);
};

// Redispatches onto a WI that already has a PR open (status=pr-open, or
// status got clobbered by a mechanical-exit requeue but pr_urls survive) are
// "fix-comments" re-entries: the worker should push to the existing branch
// rather than open a second PR. The addendum is the only signal the worker
// gets — inject it front-and-center so rule 5 (open PR) does not override.
export const buildModeAddendum = (wi: WorkItem, sessionId: string): string => {
  // PR-open takes precedence: if a WI is being resumed for reviewer comments,
  // that supersedes any stale approved plan that may still be on file.
  if (wi.pr_urls.length) return buildFixCommentsAddendum(wi, sessionId);
  const planAddendum = buildPlanApprovedAddendum(wi.id);
  if (planAddendum) return planAddendum;
  return "";
};

const buildFixCommentsAddendum = (wi: WorkItem, sessionId: string): string => {
  const prUrl = wi.pr_urls[wi.pr_urls.length - 1];
  return [
    "> **Fix-comments mode — you are resuming this work item.**",
    ">",
    `> A PR is already open at ${prUrl}. Your job this dispatch is to address the reviewer feedback on it and push the fix; do NOT open a second PR.`,
    ">",
    `> 1. Read the comments: \`gh pr view ${prUrl} --comments\` and, for inline review comments, \`gh api repos/{owner}/{repo}/pulls/{pr_number}/comments\`.`,
    "> 2. Make the smallest set of changes that addresses each comment. Reply on the PR explaining any comment you deliberately do not act on.",
    "> 3. Commit incrementally, then `git push --force-with-lease` to the existing branch.",
    `> 4. When the fix is pushed, run \`~/.claude/cos/bin/cos worker-done ${sessionId} --pr-url ${prUrl}\` and exit. The PR URL is the same on purpose — it keeps the session accounting consistent.`,
    ">",
    '> Ignore the "open the PR with `gh pr create`" instruction in rule 5 below — it does not apply to this dispatch.',
  ].join("\n");
};

// Returns a human-readable skip reason if the work item has a plan row that
// blocks dispatch. Awaiting-review means the user still owes a decision;
// feedback means a re-plan child work item is in flight. Either way, spawning
// a worker just lands the WI in `blocked` after a no-op. Approved / superseded
// / no plans = no block.
export const checkPendingPlanBlocksDispatch = (
  workItemId: string,
): string | null => {
  const latestPlan = plans.list({ workItemId })[0];
  if (latestPlan?.status === "awaiting-review") {
    return `skipped: plan ${latestPlan.id} is awaiting review — approve or send feedback in the inbox first`;
  }
  if (latestPlan?.status === "feedback") {
    return `skipped: plan ${latestPlan.id} got feedback — a re-plan child work item is regenerating; parent waits`;
  }
  return null;
};

export const cmdDispatch = (
  workItemRef: string,
  opts: { force?: boolean } = {},
) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  const workItemId = wi.id;
  const cfg = parseJson<{
    dispatch_paused?: boolean;
    auto_dispatch_max_priority?: number;
  }>(readFileSync(CONFIG_JSON, "utf8"), {});
  if (cfg.dispatch_paused && !opts.force) {
    console.error(
      chalk.yellow(
        "dispatch is paused (config.json: dispatch_paused=true). Use --force to override.",
      ),
    );
    process.exit(3);
  }
  if (!opts.force) {
    if (wi.needs_planning) {
      console.error(
        chalk.yellow(
          `skipped: ${workItemId} is flagged needs_planning — run \`cos plan ${workItemId}\` first, or use --force to bypass.`,
        ),
      );
      process.exit(3);
    }
    if (wi.priority > (cfg.auto_dispatch_max_priority ?? 3)) {
      console.error(
        chalk.yellow(
          `priority ${wi.priority} exceeds auto_dispatch_max_priority. Use --force to override.`,
        ),
      );
      process.exit(3);
    }
    if (!wi.repos.length) {
      console.error(
        chalk.yellow("no repos set; refusing to dispatch without --force"),
      );
      process.exit(3);
    }
    if (!wi.acceptance_criteria.trim()) {
      console.error(
        chalk.yellow(
          "acceptance_criteria empty; refusing to dispatch without --force",
        ),
      );
      process.exit(3);
    }
    for (const depId of wi.depends_on) {
      const dep = workItems.get(depId);
      if (!dep) {
        console.error(
          chalk.yellow(`skipped: waiting on ${depId} (status=missing)`),
        );
        process.exit(3);
      }
      if (dep.status !== "merged" && dep.status !== "done") {
        console.error(
          chalk.yellow(`skipped: waiting on ${depId} (status=${dep.status})`),
        );
        process.exit(3);
      }
    }
    // Check existing sessions on this work item
    const existing = [
      ...sessions.list({ status: "running" }),
      ...sessions.list({ status: "starting" }),
    ].filter((s) => s.work_item_id === workItemId);
    if (existing.length) {
      console.error(
        chalk.yellow(`work item already has active session: ${existing[0].id}`),
      );
      process.exit(3);
    }
    const planBlock = checkPendingPlanBlocksDispatch(workItemId);
    if (planBlock) {
      console.error(chalk.yellow(planBlock));
      process.exit(3);
    }
  }
  const spawnScript = join(COS_DIR, "bin/spawn-worker");
  if (!existsSync(spawnScript)) {
    console.error(chalk.red(`spawn-worker script not found: ${spawnScript}`));
    process.exit(2);
  }
  const res = spawnSync("bash", [spawnScript, workItemId], {
    stdio: "inherit",
  });
  if (res.status !== 0) {
    console.error(chalk.red(`spawn-worker exited with ${res.status}`));
    process.exit(res.status ?? 1);
  }
  // Flip work_item.status immediately so fleet/doctor agree with reality.
  // spawn-worker created a session via `cos session-new`; find it and bind it.
  const spawned = [
    ...sessions.list({ status: "starting" }),
    ...sessions.list({ status: "running" }),
  ]
    .filter((s) => s.work_item_id === workItemId && s.kind === "worker")
    .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
  if (spawned) {
    workItems.update(workItemId, {
      status: "in-progress",
      session_id: spawned.id,
    });
  } else {
    console.error(
      chalk.yellow(
        `dispatch: spawn-worker returned 0 but no active session found for ${workItemId}; leaving status as-is`,
      ),
    );
  }
};

export const cmdWorkerPrimaryWorktree = (workItemRef: string) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) process.exit(2);
  const first = Object.values(wi.worktree_paths)[0];
  process.stdout.write(first ?? HOME);
};

export const cmdWorkerDisplayId = (workItemRef: string) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  process.stdout.write(displayWorkItemId(wi));
};

export const cmdWorkerWindowName = (workItemRef: string) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  process.stdout.write(tmuxWindowName(displayWorkItemId(wi)));
};

export const cmdWorkItemSetDeps = (
  workItemRef: string,
  opts: { add?: string[]; remove?: string[] },
) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  const workItemId = wi.id;
  const add = opts.add ?? [];
  const remove = opts.remove ?? [];
  if (!add.length && !remove.length) {
    console.error(chalk.yellow("nothing to do: pass --add and/or --remove"));
    process.exit(2);
  }
  const resolvedAdd: string[] = [];
  const resolvedRemove: string[] = [];
  for (const [bucket, arr] of [
    ["add", add],
    ["remove", remove],
  ] as const) {
    for (const ref of arr) {
      const dep = workItems.resolve(ref);
      if (!dep) {
        console.error(chalk.red(`dep not found: ${ref}`));
        process.exit(2);
      }
      if (dep.id === workItemId) {
        console.error(chalk.red(`cannot depend on self: ${ref}`));
        process.exit(2);
      }
      (bucket === "add" ? resolvedAdd : resolvedRemove).push(dep.id);
    }
  }
  const current = new Set(wi.depends_on);
  for (const id of resolvedRemove) current.delete(id);
  for (const id of resolvedAdd) current.add(id);
  const next = Array.from(current);
  workItems.update(workItemId, { depends_on: next });
  console.log(
    chalk.green("deps updated"),
    displayWorkItemId(wi),
    chalk.gray(`depends_on=${JSON.stringify(next)}`),
  );
};
