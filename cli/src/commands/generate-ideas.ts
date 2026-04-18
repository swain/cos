import chalk from "chalk";
import { generateDiffIdeas } from "../generators/diff.js";

export const cmdGenerateIdeasDiff = async (opts: {
  dryRun?: boolean;
  since?: string;
  prLimit?: number;
  verbose?: boolean;
}) => {
  const res = await generateDiffIdeas({
    dryRun: opts.dryRun,
    sinceDate: opts.since,
    prLimit: opts.prLimit,
    verbose: opts.verbose,
  });
  const prefix = opts.dryRun
    ? chalk.yellow("[dry-run]")
    : chalk.green("[done]");
  console.log(
    `${prefix} diff generator: ${res.emitted} new idea${res.emitted === 1 ? "" : "s"}, ${res.skipped} duplicate${res.skipped === 1 ? "" : "s"} skipped`,
  );
  if (opts.verbose || opts.dryRun) {
    for (const c of res.candidates) {
      console.log(chalk.gray(`  - ${c.title}`));
    }
  }
  if (res.newIds.length && !opts.dryRun) {
    for (const id of res.newIds) console.log(chalk.cyan(`  ${id}`));
  }
};
