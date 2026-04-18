import { ulid } from "ulid";
import chalk from "chalk";
import { followups } from "../db.js";
import { FollowupTriggerSchema } from "../types.js";

export const cmdFollowupInsert = (opts: {
  topic: string;
  context?: string;
  trigger: string;
}) => {
  const parsed = FollowupTriggerSchema.safeParse(opts.trigger);
  if (!parsed.success) {
    console.error(chalk.red(`invalid --trigger: ${opts.trigger}`));
    console.error(
      chalk.gray(
        "allowed: next-dialog | before-meeting:<name> | before-workitem:<wi-id> | after-date:<iso>",
      ),
    );
    process.exit(2);
  }
  const id = `fup-${ulid()}`;
  followups.insert({
    id,
    topic: opts.topic,
    context: opts.context ?? "",
    trigger: parsed.data,
    status: "open",
  });
  console.log(chalk.green("followup"), id);
  return id;
};

export const cmdFollowupList = (status?: string) => {
  const list = followups.list(status ? { status } : undefined);
  if (!list.length) {
    console.log(chalk.gray("no followups"));
    return;
  }
  for (const f of list) {
    console.log(
      `${f.id}  ${f.status.padEnd(10)} ${f.trigger.padEnd(30)} ${f.topic}`,
    );
  }
};

export const cmdFollowupMarkRaised = (id: string) => {
  if (!followups.get(id)) {
    console.error(chalk.red(`followup not found: ${id}`));
    process.exit(2);
  }
  followups.markRaised(id);
  console.log(chalk.gray("marked raised"), id);
};

export const cmdFollowupMarkAddressed = (id: string) => {
  if (!followups.get(id)) {
    console.error(chalk.red(`followup not found: ${id}`));
    process.exit(2);
  }
  followups.markAddressed(id);
  console.log(chalk.gray("marked addressed"), id);
};
