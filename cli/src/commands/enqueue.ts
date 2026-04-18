import { ulid } from "ulid";
import chalk from "chalk";
import { workItems } from "../db.js";
import type { WorkItemStatus } from "../types.js";

export type EnqueueArgs = {
  title: string;
  description: string;
  acceptance: string;
  repos: string[];
  priority: number;
  source?: string;
  status?: WorkItemStatus;
  parentId?: string | null;
  needsPlanning?: boolean;
  dependsOn?: string[];
};

export const cmdEnqueue = (args: EnqueueArgs): string => {
  const id = `wi-${ulid()}`;
  workItems.insert({
    id,
    title: args.title,
    description: args.description,
    acceptance_criteria: args.acceptance,
    repos: args.repos,
    priority: args.priority,
    status: args.status ?? "queued",
    source: args.source ?? "user",
    depends_on: args.dependsOn ?? [],
    session_id: null,
    pr_urls: [],
    worklog_path: null,
    worktree_paths: {},
    needs_approval: false,
    parent_id: args.parentId ?? null,
    needs_planning: args.needsPlanning ?? false,
  });
  console.log(
    chalk.green("enqueued"),
    id,
    chalk.gray(`priority=${args.priority} repos=${args.repos.join(",")}`),
  );
  return id;
};
