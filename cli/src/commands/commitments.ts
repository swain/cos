import chalk from "chalk";
import {
  loadLedger,
  saveLedger,
  newCommitmentId,
  type Commitment,
} from "../commitments.js";

const today = () => new Date().toISOString().slice(0, 10);

export const cmdCommitmentsList = (opts: {
  due?: "today" | "overdue" | "all";
  format?: "text" | "json";
}) => {
  let items = loadLedger().filter((c) => !c.done);
  const t = today();
  if (opts.due === "today") items = items.filter((c) => c.due && c.due <= t);
  if (opts.due === "overdue") items = items.filter((c) => c.due && c.due < t);
  if (opts.format === "json") {
    console.log(JSON.stringify(items, null, 2));
    return;
  }
  if (!items.length) {
    console.log(chalk.gray("no open commitments"));
    return;
  }
  for (const c of items) {
    const due = c.due
      ? c.due < t
        ? chalk.red(` due:${c.due}`)
        : chalk.yellow(` due:${c.due}`)
      : "";
    console.log(`${c.id}  ${chalk.cyan(c.who)}  ${c.what}${due}`);
  }
};

export const cmdCommitmentsAdd = (opts: {
  who: string;
  what: string;
  due?: string;
  source?: string;
}) => {
  const items = loadLedger();
  const dup = items.find(
    (c) =>
      !c.done &&
      c.who === opts.who.toLowerCase() &&
      c.what.toLowerCase() === opts.what.toLowerCase(),
  );
  if (dup) {
    console.log(chalk.yellow("duplicate of"), dup.id, chalk.gray("— skipped"));
    return;
  }
  const c: Commitment = {
    id: newCommitmentId(),
    who: opts.who.toLowerCase(),
    what: opts.what,
    due: opts.due ?? null,
    source: opts.source ?? null,
    added: today(),
    done: false,
  };
  items.push(c);
  saveLedger(items);
  console.log(chalk.green("added"), c.id);
};

export const cmdCommitmentsDone = (id: string) => {
  const items = loadLedger();
  const c = items.find((x) => x.id === id);
  if (!c) {
    console.error(chalk.red("not found:"), id);
    process.exit(2);
  }
  c.done = true;
  saveLedger(items);
  console.log(chalk.green("done"), id);
};
