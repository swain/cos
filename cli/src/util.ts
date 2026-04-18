import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

export const HOME = homedir();
export const COS_DIR = join(HOME, ".claude/cos");
export const DB_PATH = join(COS_DIR, "fleet.db");
export const SCHEMA_PATH = join(COS_DIR, "cli/src/schema.sql");
export const LOGS_DIR = join(COS_DIR, "logs");
export const WORKLOGS_DIR = join(COS_DIR, "worklogs");
export const MEETINGS_DIR = join(COS_DIR, "meetings");
export const PROMPTS_DIR = join(COS_DIR, "prompts");
export const STATUS_MD = join(COS_DIR, "status.md");
export const DECISIONS_LOG = join(COS_DIR, "decisions.log");
export const CONFIG_JSON = join(COS_DIR, "config.json");
export const WATCHED_REPOS_JSON = join(COS_DIR, "watched-repos.json");

export const CLAUDE_BIN = join(HOME, ".local/bin/claude");
export const CLAUDE_PLUGIN_DIR = join(HOME, "Repos/claude-projects");

export const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const nowIso = () => new Date().toISOString();

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

export const tableRow = (cells: (string | number)[], widths: number[]) =>
  cells.map((c, i) => String(c).padEnd(widths[i] ?? 20)).join("  ");

export const shortRepoName = (name: string): string =>
  name.includes("/") ? name.split("/").pop()! : name;

// Repo entries in watched-repos.json may be plain strings ("owner/repo") or
// objects ({ name, base_branch }). Object form lets a repo override the
// global default_base_branch — needed because, e.g., cos uses `main` while
// thegoodparty/* use `develop`.
export type WatchedRepoEntry = string | { name: string; base_branch?: string };

export type WatchedReposFile = {
  repos?: WatchedRepoEntry[];
  default_base_branch?: string;
};

export const watchedRepoName = (entry: WatchedRepoEntry): string =>
  typeof entry === "string" ? entry : entry.name;

export const loadWatchedRepoBaseBranches = (
  path: string,
): {
  defaultBaseBranch: string;
  baseBranchByShortName: Record<string, string>;
} => {
  const cfg = existsSync(path)
    ? parseJson<WatchedReposFile>(readFileSync(path, "utf8"), {})
    : {};
  const defaultBaseBranch = cfg.default_base_branch ?? "develop";
  const baseBranchByShortName: Record<string, string> = {};
  for (const entry of cfg.repos ?? []) {
    if (typeof entry === "string") continue;
    if (entry.base_branch) {
      baseBranchByShortName[shortRepoName(entry.name)] = entry.base_branch;
    }
  }
  return { defaultBaseBranch, baseBranchByShortName };
};
