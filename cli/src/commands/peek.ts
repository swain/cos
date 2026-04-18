import { spawnSync } from "node:child_process";
import chalk from "chalk";

const SESSION = "cos-workers";

export const cmdPeek = (opts: { list?: boolean } = {}) => {
  const which = spawnSync("which", ["tmux"], { stdio: "ignore" });
  if (which.status !== 0) {
    console.error(
      chalk.red("tmux is not installed."),
      "Install it (e.g. `brew install tmux`) and try again.",
    );
    process.exit(2);
  }

  const has = spawnSync("tmux", ["has-session", "-t", SESSION], {
    stdio: "ignore",
  });
  if (has.status !== 0) {
    console.log(
      chalk.gray(`No workers running (tmux session "${SESSION}" not found).`),
    );
    console.log(chalk.gray("Run `cos fleet` to see queue and session state."));
    process.exit(0);
  }

  const args = opts.list
    ? ["list-windows", "-t", SESSION]
    : ["attach-session", "-t", SESSION];
  const child = spawnSync("tmux", args, { stdio: "inherit" });
  process.exit(child.status ?? 1);
};
