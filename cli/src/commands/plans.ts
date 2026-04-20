import { ulid } from "ulid";
import chalk from "chalk";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { plans, workItems } from "../db.js";
import { cmdEnqueue } from "./enqueue.js";
import { COS_DIR, displayWorkItemId } from "../util.js";

// Overridable via COS_PLANS_DIR so tests can point at a temp directory
// instead of polluting ~/.claude/cos/plans.
const plansDir = (): string =>
  process.env.COS_PLANS_DIR || join(COS_DIR, "plans");

// Extract title (first H1) + blurb (first paragraph after H1) from plan
// markdown. Used by the dashboard to show a human subject/body without the
// raw path or a filename fallback. Fail soft: if the file is unreadable we
// still return a reasonable default.
export const summarizePlan = (
  path: string,
): { title: string; blurb: string } => {
  let md = "";
  try {
    md = readFileSync(path, "utf8");
  } catch {
    return { title: path.split("/").pop() ?? path, blurb: "" };
  }
  const lines = md.split(/\r?\n/);
  let title = "";
  let blurb = "";
  for (let i = 0; i < lines.length; i++) {
    const h = /^#\s+(.+)$/.exec(lines[i]);
    if (h) {
      title = h[1].trim();
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (!t) continue;
        if (t.startsWith("#")) break;
        blurb = t;
        break;
      }
      break;
    }
  }
  if (!title) title = path.split("/").pop() ?? path;
  return { title, blurb };
};

export type PlanSubmitOpts = {
  path: string;
};

// Copies the plan markdown into ~/.claude/cos/plans/ so the user can't
// accidentally delete it with a worktree cleanup, then inserts a row. Idempotent
// on the destination filename: a second submit for the same wi overwrites the
// file and creates a fresh awaiting-review row (old rows are left alone —
// supersede via cos plan-resubmit / doctor invariant, not here).
export const cmdPlanSubmit = (workItemRef: string, opts: PlanSubmitOpts) => {
  const wi = workItems.resolve(workItemRef);
  if (!wi) {
    console.error(chalk.red(`work item not found: ${workItemRef}`));
    process.exit(2);
  }
  if (!existsSync(opts.path)) {
    console.error(chalk.red(`plan file not found: ${opts.path}`));
    process.exit(2);
  }
  const dir = plansDir();
  mkdirSync(dir, { recursive: true });
  const display = displayWorkItemId(wi);
  const destName = `${display}-${Date.now()}.md`;
  const dest = join(dir, destName);
  copyFileSync(opts.path, dest);
  const id = `plan-${ulid()}`;
  plans.insert({ id, work_item_id: wi.id, path: dest });
  console.log(chalk.green("plan submitted"), id, chalk.gray(dest));
  console.log(
    chalk.gray(`  review in the inbox dashboard (Review section) to approve`),
  );
  return id;
};

export const cmdPlanStatus = (planId: string) => {
  const p = plans.get(planId);
  if (!p) {
    console.error(chalk.red(`plan not found: ${planId}`));
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(p, null, 2) + "\n");
};

// Marks the plan approved and redispatches the originating work item. The
// worker prompt (via plans.latestApprovedForWorkItem) tells the resumed
// worker to execute against the reviewed plan rather than re-plan.
export const cmdPlanApprove = async (planId: string): Promise<void> => {
  const p = plans.get(planId);
  if (!p) {
    console.error(chalk.red(`plan not found: ${planId}`));
    process.exit(2);
  }
  if (p.status !== "awaiting-review") {
    console.error(
      chalk.yellow(`plan ${planId} is ${p.status}, not awaiting-review`),
    );
    process.exit(3);
  }
  plans.update(planId, {
    status: "approved",
    reviewed_at: new Date().toISOString(),
  });
  console.log(chalk.green("approved"), planId);
  if (!p.work_item_id) return;
  const wi = workItems.get(p.work_item_id);
  if (!wi) return;
  // Unstick the WI so `cos dispatch` will pick it up, then dispatch. The
  // worker prompt (buildPlanReviewAddendum in commands/workitems.ts) reads
  // the latest approved plan and injects it as MODE_ADDENDUM context.
  if (wi.status !== "queued") {
    workItems.update(wi.id, { status: "queued", session_id: null });
  }
  const dispatch = spawnSync(join(COS_DIR, "bin/cos"), ["dispatch", wi.id], {
    stdio: "inherit",
  });
  if (dispatch.status !== 0) {
    console.error(
      chalk.yellow(
        `approved ${planId} but dispatch of ${displayWorkItemId(wi)} failed; redispatch manually`,
      ),
    );
  }
};

export type PlanResubmitOpts = {
  feedback?: string;
};

// Records the reviewer's inline comments on the plan and spawns a new work
// item that re-runs planning with the feedback in context. The new WI is
// plan-review-gated the same way the original was, so its worker re-enters
// the awaiting-review queue after re-planning.
export const cmdPlanResubmit = (planId: string, opts: PlanResubmitOpts) => {
  const p = plans.get(planId);
  if (!p) {
    console.error(chalk.red(`plan not found: ${planId}`));
    process.exit(2);
  }
  if (p.status !== "awaiting-review") {
    console.error(
      chalk.yellow(`plan ${planId} is ${p.status}, not awaiting-review`),
    );
    process.exit(3);
  }
  const feedback = opts.feedback ?? "";
  plans.update(planId, {
    status: "feedback",
    feedback_body: feedback,
    reviewed_at: new Date().toISOString(),
  });
  console.log(chalk.yellow("feedback"), planId);
  if (!p.work_item_id) return;
  const wi = workItems.get(p.work_item_id);
  if (!wi) return;
  const planMd = existsSync(p.path) ? readFileSync(p.path, "utf8") : "";
  const description = [
    `Regenerate the plan for **${wi.title}** using the reviewer's feedback below.`,
    "",
    "Use the `superpowers:writing-plans` skill, then persist the plan via `cos plan-submit <wi-id> --path <md-path>` and exit.",
    "",
    "## Original plan",
    "",
    "```markdown",
    planMd,
    "```",
    "",
    "## Reviewer feedback",
    "",
    feedback || "(no feedback body recorded)",
    "",
    "## Original goal",
    "",
    wi.description,
  ].join("\n");
  const childId = cmdEnqueue({
    title: `Re-plan: ${wi.title}`,
    description,
    acceptance: `Re-authored plan addresses the reviewer feedback and is submitted via cos plan-submit. Exit once the plan row is awaiting-review.`,
    repos: wi.repos,
    priority: wi.priority,
    source: `plan-feedback:${planId}`,
    parentId: wi.id,
    needsPlanning: false,
  });
  console.log(chalk.gray(`  spawned re-plan work item ${childId}`));
};

// Mark awaiting-review → superseded. Used by the dashboard Dismiss button
// and by the doctor invariant for plans that age out.
export const cmdPlanSupersede = (planId: string, note?: string) => {
  const p = plans.get(planId);
  if (!p) {
    console.error(chalk.red(`plan not found: ${planId}`));
    process.exit(2);
  }
  const patch: { status: "superseded"; reviewed_at: string; path?: string } = {
    status: "superseded",
    reviewed_at: new Date().toISOString(),
  };
  if (note) {
    const marker = `\n\n<!-- superseded: ${note} -->\n`;
    try {
      writeFileSync(p.path, readFileSync(p.path, "utf8") + marker);
    } catch {
      // plan file might be gone; row-level status is the source of truth
    }
  }
  plans.update(planId, patch);
  console.log(chalk.gray("superseded"), planId);
};

// Runs `plannotator annotate <path>`. We pipe stdout so we can capture the
// feedback body the tool prints on submit (its stderr carries progress + the
// server URL, so we inherit that). On "Send feedback" with a non-empty body,
// plannotator writes the feedback text to stdout; with an empty body it writes
// "No feedback provided." — we use that sentinel to fall through to the
// approve/skip prompt.
const PLANNOTATOR_EMPTY_FEEDBACK = "No feedback provided.";

// Decide how to act on plannotator's post-exit stdout. "Send feedback" with a
// body → resubmit directly; empty / sentinel → ask the user approve/skip so
// they can still approve without retyping anything.
export const decidePlanReviewAction = (
  stdout: string,
): { kind: "resubmit"; feedback: string } | { kind: "prompt" } => {
  const feedback = stdout.trim();
  if (!feedback || feedback === PLANNOTATOR_EMPTY_FEEDBACK) {
    return { kind: "prompt" };
  }
  return { kind: "resubmit", feedback };
};

const runPlannotatorAnnotate = (
  path: string,
): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const child = spawn("plannotator", ["annotate", path], {
      stdio: ["inherit", "pipe", "inherit"],
    });
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf8");
      resolve({ code: code ?? 0, stdout });
    });
    child.on("error", (err) => {
      console.error(chalk.red(`plannotator failed: ${err.message}`));
      resolve({ code: 1, stdout: "" });
    });
  });

type ReviewChoice = "approve" | "feedback" | "skip";

const PROMPT = "Action? [a]pprove / [f]eedback / [s]kip: ";

const parseReviewChoice = (raw: string): ReviewChoice | null => {
  const c = raw.trim().toLowerCase();
  if (c === "a" || c === "approve") return "approve";
  if (c === "f" || c === "feedback") return "feedback";
  if (c === "s" || c === "skip" || c === "") return "skip";
  return null;
};

// Interactive review flow for a single plan: open plannotator on the plan
// markdown, then persist the user's decision. Mirrors cmdReviewPr. When the
// user clicks "Send feedback" in plannotator with a non-empty body, we
// auto-resubmit with that body — no second terminal prompt. If the body is
// empty (or plannotator exited without a usable payload), fall back to the
// interactive approve/feedback/skip prompt so the user can still approve.
export const cmdPlanReview = async (planId: string): Promise<void> => {
  const p = plans.get(planId);
  if (!p) {
    console.error(chalk.red(`plan not found: ${planId}`));
    process.exit(2);
  }
  if (p.status !== "awaiting-review") {
    console.error(
      chalk.yellow(`plan ${planId} is ${p.status}, not awaiting-review`),
    );
    process.exit(3);
  }
  console.log(chalk.cyan(`\n→ Reviewing plan: ${p.path}`));
  const { code, stdout } = await runPlannotatorAnnotate(p.path);
  if (code !== 0) {
    console.log(
      chalk.yellow(`  plannotator exited ${code} — skipping decision prompt`),
    );
    return;
  }
  const decision = decidePlanReviewAction(stdout);
  if (decision.kind === "resubmit") {
    console.log(chalk.yellow("  received feedback from plannotator"));
    cmdPlanResubmit(planId, { feedback: decision.feedback });
    return;
  }
  const rl = readline.createInterface({ input, output });
  let choice: ReviewChoice | null = null;
  while (choice === null) {
    const raw = await rl.question(PROMPT);
    choice = parseReviewChoice(raw);
    if (!choice) console.log(chalk.yellow("  unknown choice, try again"));
  }
  if (choice === "skip") {
    rl.close();
    console.log(chalk.gray("  skipped — plan still awaiting-review"));
    return;
  }
  if (choice === "approve") {
    rl.close();
    await cmdPlanApprove(planId);
    return;
  }
  const body = (
    await rl.question("  feedback body (or paste annotations): ")
  ).trim();
  rl.close();
  cmdPlanResubmit(planId, { feedback: body });
};

// Rendered at prompt time (not persisted) and injected into MODE_ADDENDUM so
// a redispatched worker knows an approved plan exists and should execute it.
export const buildPlanApprovedAddendum = (
  workItemId: string,
): string | null => {
  const p = plans.latestApprovedForWorkItem(workItemId);
  if (!p) return null;
  const reviewedAt = p.reviewed_at ?? "recently";
  return [
    "> **Plan-approved mode — execute the reviewed plan.**",
    ">",
    `> The user approved a plan for this work item at ${reviewedAt}. The plan markdown is at:`,
    ">",
    `> \`${p.path}\``,
    ">",
    "> Use the `superpowers:executing-plans` skill against that file. Do NOT re-plan. Do NOT invoke `superpowers:writing-plans` again. The plan you are executing has already been reviewed and signed off.",
    ">",
    "> Follow the normal rules below for commits, tests, and PR opening.",
  ].join("\n");
};
