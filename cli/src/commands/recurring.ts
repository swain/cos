import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import chalk from "chalk";
import { recurring } from "../db.js";
import { COS_DIR, nowIso } from "../util.js";

const resolvePromptPath = (p: string) => {
  if (isAbsolute(p)) return p;
  if (p.startsWith("~/")) return join(process.env.HOME ?? "", p.slice(2));
  return join(COS_DIR, p);
};

export const cmdRecurringList = (opts: { enabled?: boolean } = {}) => {
  const rows = recurring.list({ enabled: opts.enabled });
  if (!rows.length) {
    console.log(chalk.gray("no recurring tasks"));
    return;
  }
  for (const r of rows) {
    const mark = r.enabled ? chalk.green("on ") : chalk.gray("off");
    const due = r.next_run_at <= nowIso() ? chalk.yellow(" [DUE]") : "";
    console.log(
      `${mark}  ${r.id}  every ${r.cadence_hours}h  next ${r.next_run_at}${due}`,
    );
    console.log(`      ${chalk.gray(r.title)}`);
    if (r.last_run_at) {
      const tag =
        r.last_status === "failed" ? chalk.red("failed") : chalk.green("ok");
      console.log(
        `      last ${r.last_run_at} ${tag}${r.last_notes ? " — " + r.last_notes : ""}`,
      );
    }
  }
};

export const cmdRecurringAdd = (opts: {
  id: string;
  title: string;
  hours: number;
  promptFile: string;
  startAt?: string;
}) => {
  if (!opts.id.startsWith("rec-")) {
    console.error(chalk.red(`id must start with 'rec-': got ${opts.id}`));
    process.exit(2);
  }
  const resolved = resolvePromptPath(opts.promptFile);
  if (!existsSync(resolved)) {
    console.error(chalk.red(`prompt file not found: ${resolved}`));
    process.exit(2);
  }
  if (recurring.get(opts.id)) {
    console.error(chalk.red(`already exists: ${opts.id}`));
    process.exit(2);
  }
  const nextRun = opts.startAt ?? nowIso();
  recurring.insert({
    id: opts.id,
    title: opts.title,
    cadence_hours: opts.hours,
    prompt_path: resolved,
    enabled: true,
    next_run_at: nextRun,
  });
  console.log(chalk.green("added"), opts.id, chalk.gray(`next ${nextRun}`));
};

export const cmdRecurringDue = (opts: { format?: "text" | "json" } = {}) => {
  const rows = recurring.listDue(nowIso());
  if (opts.format === "json") {
    const enriched = rows.map((r) => ({
      ...r,
      prompt: existsSync(r.prompt_path)
        ? readFileSync(r.prompt_path, "utf8")
        : null,
    }));
    console.log(JSON.stringify(enriched, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(chalk.gray("no due tasks"));
    return;
  }
  for (const r of rows) {
    console.log(`${r.id}  ${chalk.gray(r.title)}`);
    console.log(`  prompt: ${r.prompt_path}`);
    console.log(`  due since: ${r.next_run_at}`);
  }
};

export const cmdRecurringMarkRan = (
  id: string,
  opts: { status?: "ok" | "failed"; notes?: string },
) => {
  const t = recurring.get(id);
  if (!t) {
    console.error(chalk.red(`not found: ${id}`));
    process.exit(2);
  }
  recurring.markRan(id, {
    status: opts.status ?? "ok",
    notes: opts.notes,
  });
  const updated = recurring.get(id)!;
  console.log(
    chalk.green("marked ran"),
    id,
    chalk.gray(`next ${updated.next_run_at}`),
  );
};

export const cmdRecurringSetEnabled = (id: string, enabled: boolean) => {
  if (!recurring.get(id)) {
    console.error(chalk.red(`not found: ${id}`));
    process.exit(2);
  }
  recurring.setEnabled(id, enabled);
  console.log(enabled ? chalk.green("enabled") : chalk.yellow("disabled"), id);
};
