import { execSync } from "node:child_process";
import chalk from "chalk";
import { HOME } from "../util.js";

const DOTFILES_GIT_DIR = `${HOME}/Repos/dotfiles`;
const DOTFILES_WORKTREE = HOME;

// Paths (relative to $HOME) that are committable
const COMMIT_ALLOWLIST = [
  ".claude/cos/design.md",
  ".claude/cos/implementation-plan.md",
  ".claude/cos/USING_COS.md",
  ".claude/cos/system.md",
  ".claude/cos/arch.md",
  ".claude/cos/ai-native.md",
  ".claude/cos/prompts/cron.md",
  ".claude/cos/prompts/worker.md",
  ".claude/cos/bin/cos",
  ".claude/cos/bin/cos-tick",
  ".claude/cos/bin/spawn-worker",
  ".claude/cos/cli/package.json",
  ".claude/cos/cli/tsconfig.json",
  ".claude/cos/cli/src",
  ".claude/cos/launchd/com.smolster.cos.cron.plist.template",
  ".claude/CLAUDE.md",
  ".claude/commands/fleet.md",
  ".claude/commands/enqueue.md",
  ".claude/commands/cos.md",
  ".claude/commands/groom.md",
  ".claude/commands/dispatch.md",
];

const dotfilesGit = (
  args: string[],
  opts: { stdio?: "inherit" | "pipe" } = {},
) =>
  execSync(
    `/usr/bin/git --git-dir="${DOTFILES_GIT_DIR}" --work-tree="${DOTFILES_WORKTREE}" ${args.map((a) => `"${a}"`).join(" ")}`,
    {
      stdio: opts.stdio ?? "inherit",
      encoding: "utf8",
    },
  );

export const cmdDotfilesSync = (opts: { push?: boolean } = {}) => {
  console.log(chalk.blue("staging committable COS files to dotfiles repo…"));
  for (const rel of COMMIT_ALLOWLIST) {
    try {
      dotfilesGit(["add", rel], { stdio: "pipe" });
    } catch (e: any) {
      console.error(
        chalk.yellow(`  skip ${rel}: ${String(e.message).split("\n")[0]}`),
      );
    }
  }
  console.log(chalk.blue("\ndiff:"));
  try {
    dotfilesGit(["diff", "--cached", "--stat"]);
  } catch (e: any) {
    console.error(chalk.yellow(e.message));
  }
  if (!opts.push) {
    console.log(
      chalk.gray("\n(dry): not committing. Pass --push to commit + push."),
    );
    return;
  }
  const msg = `COS: sync ${new Date().toISOString().slice(0, 10)}`;
  try {
    dotfilesGit(["commit", "-m", msg]);
    dotfilesGit(["push"]);
    console.log(chalk.green("pushed."));
  } catch (e: any) {
    console.error(chalk.red(`commit/push failed: ${e.message}`));
    process.exit(1);
  }
};
