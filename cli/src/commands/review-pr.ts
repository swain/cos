import { spawn, spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import chalk from "chalk";

// Parse a GitHub PR URL like https://github.com/org/repo/pull/123 into
// { repo, number }. Returns null for anything else — we don't want to try
// mirroring reviews back to a URL we don't recognise.
const parsePrUrl = (url: string): { repo: string; number: number } | null => {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/,
  );
  if (!m) return null;
  return { repo: m[1], number: parseInt(m[2], 10) };
};

const runPlannotator = (url: string): Promise<number> =>
  new Promise((resolve) => {
    const child = spawn("plannotator", ["review", url], { stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(chalk.red(`plannotator failed: ${err.message}`));
      resolve(1);
    });
  });

type MirrorAction = "approve" | "comment" | "request-changes" | "skip";

const MIRROR_PROMPT =
  "Mirror to GitHub? [a]pprove / [c]omment / [r]equest-changes / [s]kip: ";

const parseChoice = (raw: string): MirrorAction | null => {
  const c = raw.trim().toLowerCase();
  if (c === "a" || c === "approve") return "approve";
  if (c === "c" || c === "comment") return "comment";
  if (c === "r" || c === "request-changes" || c === "rc")
    return "request-changes";
  if (c === "s" || c === "skip" || c === "") return "skip";
  return null;
};

const promptMirror = async (): Promise<{
  action: MirrorAction;
  body: string;
}> => {
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const raw = await rl.question(MIRROR_PROMPT);
      const action = parseChoice(raw);
      if (!action) {
        console.log(chalk.yellow("  unknown choice, try again"));
        continue;
      }
      if (action === "skip") return { action, body: "" };
      const body = await rl.question(
        "  comment body (empty to skip comment): ",
      );
      return { action, body: body.trim() };
    }
  } finally {
    rl.close();
  }
};

const ghReview = (
  repo: string,
  num: number,
  action: Exclude<MirrorAction, "skip">,
  body: string,
): boolean => {
  const flag =
    action === "approve"
      ? "--approve"
      : action === "request-changes"
        ? "--request-changes"
        : "--comment";
  const args = [
    "pr",
    "review",
    "--repo",
    repo,
    String(num),
    flag,
    ...(body ? ["--body", body] : []),
  ];
  const r = spawnSync("gh", args, { stdio: "inherit" });
  return r.status === 0;
};

// Walk through one or more PR URLs: plannotator each, prompt for gh mirror,
// move on. Errors in one PR don't stop the rest — the user is driving.
export const cmdReviewPr = async (urls: string[]): Promise<void> => {
  if (!urls.length) {
    console.error(chalk.red("usage: cos review <pr-url> [<pr-url>...]"));
    process.exit(2);
  }

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const header = urls.length > 1 ? ` (${i + 1}/${urls.length})` : "";
    console.log(chalk.cyan(`\n→ Reviewing${header}: ${url}`));

    const parsed = parsePrUrl(url);
    if (!parsed) {
      console.log(
        chalk.yellow(
          `  not a github.com PR URL — running plannotator without gh mirror`,
        ),
      );
    }

    const code = await runPlannotator(url);
    if (code !== 0) {
      console.log(
        chalk.yellow(
          `  plannotator exited with code ${code} — skipping mirror`,
        ),
      );
      continue;
    }

    if (!parsed) continue;

    const { action, body } = await promptMirror();
    if (action === "skip") {
      console.log(chalk.gray("  skipped gh mirror"));
      continue;
    }
    const ok = ghReview(parsed.repo, parsed.number, action, body);
    console.log(
      ok ? chalk.green("  gh review posted") : chalk.red("  gh review failed"),
    );
  }

  console.log(
    chalk.green(`\n✓ done (${urls.length} PR${urls.length === 1 ? "" : "s"})`),
  );
};
