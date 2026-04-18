import { appendFileSync, readFileSync } from "node:fs";
import chalk from "chalk";
import { DECISIONS_LOG } from "../util.js";

export const cmdLogAppend = (text: string, opts: { tickId?: string } = {}) => {
  const body = text === "-" ? readFileSync(0, "utf8") : text;
  const trimmed = body.replace(/\s+$/, "");
  if (!trimmed) {
    console.error(chalk.red("log-append: empty input"));
    process.exit(2);
  }
  const iso = new Date().toISOString();
  const header = opts.tickId ? `[${iso}] tick ${opts.tickId}` : `[${iso}]`;
  const entry = `\n---\n${header}\n${trimmed}\n`;
  appendFileSync(DECISIONS_LOG, entry);
  console.log(chalk.gray("log-append"), iso, opts.tickId ?? "");
};
