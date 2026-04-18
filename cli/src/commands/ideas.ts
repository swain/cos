import { ulid } from "ulid";
import chalk from "chalk";
import { ideas, workItems } from "../db.js";
import { displayWorkItemId } from "../util.js";

export const cmdIdeasList = (status?: string) => {
  const list = ideas.list(status ? { status } : undefined);
  if (!list.length) {
    console.log(chalk.gray("no ideas"));
    return;
  }
  for (const i of list) {
    console.log(
      `${i.id}  ${i.status.padEnd(10)} conf=${i.confidence.toFixed(2)} ${i.source.padEnd(30)} ${i.title}`,
    );
  }
};

export const cmdIdeaPromote = (
  ideaId: string,
  opts: {
    priority: number;
    repos: string[];
    acceptance: string;
    title?: string;
    description?: string;
  },
) => {
  const i = ideas.get(ideaId);
  if (!i) {
    console.error(chalk.red(`idea not found: ${ideaId}`));
    process.exit(2);
  }
  const wiId = `wi-${ulid()}`;
  const { num, slug } = workItems.insert({
    id: wiId,
    title: opts.title ?? i.title,
    description: opts.description ?? i.description,
    acceptance_criteria: opts.acceptance,
    repos: opts.repos,
    priority: opts.priority,
    status: "queued",
    source: `idea:${ideaId}`,
    depends_on: [],
    session_id: null,
    pr_urls: [],
    worklog_path: null,
    worktree_paths: {},
    needs_approval: false,
    parent_id: null,
    needs_planning: false,
  });
  ideas.update(ideaId, { status: "promoted", promoted_to: wiId });
  console.log(
    chalk.green("promoted"),
    ideaId,
    "→",
    displayWorkItemId({ id: wiId, num, slug }),
  );
};

export const cmdIdeaInsert = (opts: {
  title: string;
  description: string;
  source?: string;
  confidence?: number;
  repos?: string[];
}) => {
  const id = `idea-${ulid()}`;
  ideas.insert({
    id,
    title: opts.title,
    description: opts.description,
    source: opts.source ?? "user",
    confidence: opts.confidence ?? 0.5,
    repos_guess: opts.repos ?? [],
    status: "new",
    promoted_to: null,
  });
  console.log(chalk.green("idea"), id);
  return id;
};
