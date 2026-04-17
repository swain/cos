import { ulid } from "ulid";
import chalk from "chalk";
import { notifications } from "../db.js";
import type { Urgency } from "../types.js";

export const cmdNotify = (opts: {
  subject: string;
  body?: string;
  urgency?: Urgency;
  related?: string[];
}) => {
  const id = `notif-${ulid()}`;
  notifications.insert({
    id,
    subject: opts.subject,
    body: opts.body ?? "",
    urgency: opts.urgency ?? "normal",
    related_ids: opts.related ?? [],
    pushed_at: null,
  });
  console.log(
    chalk.green("notification"),
    id,
    chalk.gray(opts.urgency ?? "normal"),
  );
  return id;
};

export const cmdNotifyListUnpushed = () => {
  const list = notifications.listUnpushed();
  if (!list.length) {
    console.log(chalk.gray("no unpushed notifications"));
    return;
  }
  for (const n of list) {
    console.log(`${n.id}  [${n.urgency}]  ${n.subject}`);
  }
};

export const cmdNotifyMarkPushed = (id: string) => {
  notifications.markPushed(id);
  console.log(chalk.gray("marked pushed"), id);
};
