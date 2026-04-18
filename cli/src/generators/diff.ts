import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  HOME,
  WATCHED_REPOS_JSON,
  parseJson,
  shortRepoName,
  watchedRepoName,
  type WatchedReposFile,
} from "../util.js";
import { ideas } from "../db.js";

export type DiffIdeaCandidate = {
  title: string;
  description: string;
  repos: string[];
  confidence: number;
  dedup_key: string;
};

export type GenerateDiffOpts = {
  dryRun?: boolean;
  sinceDate?: string;
  prLimit?: number;
  verbose?: boolean;
};

export type GenerateDiffResult = {
  emitted: number;
  skipped: number;
  candidates: DiffIdeaCandidate[];
  newIds: string[];
};

const LARGE_FILE_THRESHOLD = 600;
const SERVICE_WARN_THRESHOLD = 400;

const gh = (args: string[]): any => {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e: any) {
    console.error(
      `[diff] gh ${args.slice(0, 3).join(" ")}... failed: ${String(e.message ?? e).slice(0, 200)}`,
    );
    return null;
  }
};

const ghText = (args: string[]): string | null => {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
  } catch (e: any) {
    console.error(
      `[diff] gh ${args.slice(0, 3).join(" ")}... failed: ${String(e.message ?? e).slice(0, 200)}`,
    );
    return null;
  }
};

const hash16 = (s: string) =>
  createHash("sha256").update(s).digest("hex").slice(0, 16);

const isoDateDaysAgo = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
};

const getWatchedRepos = (): string[] => {
  if (!existsSync(WATCHED_REPOS_JSON)) return [];
  const cfg = parseJson<WatchedReposFile>(
    readFileSync(WATCHED_REPOS_JSON, "utf8"),
    {},
  );
  return (cfg.repos ?? []).map(watchedRepoName);
};

// Watched repos are "owner/repo"; local clones may be at ~/Repos/<owner>/<repo>
// or ~/Repos/<repo>. Return the first one that exists, or null.
const localRepoPath = (fullName: string): string | null => {
  const [owner, repo] = fullName.includes("/")
    ? fullName.split("/")
    : [null, fullName];
  const candidates: string[] = [];
  if (owner) candidates.push(join(HOME, "Repos", owner, repo!));
  if (repo) candidates.push(join(HOME, "Repos", repo));
  for (const p of candidates) {
    try {
      if (existsSync(p) && statSync(p).isDirectory()) return p;
    } catch {
      // ignore
    }
  }
  return null;
};

const isCodeFile = (path: string): boolean => {
  return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rb|java|rs)$/.test(path);
};

const isExcludedPath = (path: string): boolean => {
  return (
    /(^|\/)(node_modules|dist|build|\.next|coverage|vendor|\.venv|__pycache__)\//.test(
      path,
    ) ||
    /\.(min\.js|bundle\.js|map)$/.test(path) ||
    path.endsWith(".lock") ||
    path.endsWith(".snap")
  );
};

const TODO_RE = /\b(TODO|FIXME|XXX|HACK)\b/;
const CONSOLE_LOG_RE = /\bconsole\.(log|debug)\s*\(/;

type DiffScan = {
  touchedFiles: Set<string>;
  todos: { file: string; line: string }[];
  consoleLogs: { file: string; line: string }[];
};

// Parse unified diff. Only track lines starting with "+" (added) and skip "+++"
// file headers. Track the current "+++ b/<path>" target file as we iterate.
const scanDiff = (diff: string): DiffScan => {
  const out: DiffScan = {
    touchedFiles: new Set<string>(),
    todos: [],
    consoleLogs: [],
  };
  let currentFile: string | null = null;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      // +++ b/path/to/file.ts  or  +++ /dev/null
      const m = /^\+\+\+ (?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
      if (m && m[1] !== "/dev/null") {
        currentFile = m[1];
        if (!isExcludedPath(currentFile)) {
          out.touchedFiles.add(currentFile);
        } else {
          currentFile = null;
        }
      } else {
        currentFile = null;
      }
      continue;
    }
    if (line.startsWith("---") || line.startsWith("@@")) continue;
    if (!currentFile) continue;
    if (!line.startsWith("+")) continue;
    const added = line.slice(1);
    if (TODO_RE.test(added)) {
      out.todos.push({ file: currentFile, line: added.trim() });
    }
    if (
      isCodeFile(currentFile) &&
      /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(currentFile) &&
      CONSOLE_LOG_RE.test(added) &&
      !/\/\/.*console\.log/.test(added)
    ) {
      out.consoleLogs.push({ file: currentFile, line: added.trim() });
    }
  }
  return out;
};

const countLines = (absPath: string): number | null => {
  try {
    const buf = readFileSync(absPath);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
    if (buf.length > 0 && buf[buf.length - 1] !== 0x0a) n++;
    return n;
  } catch {
    return null;
  }
};

const emitTodoIdea = (
  repo: string,
  prUrl: string,
  prNumber: number,
  prTitle: string,
  items: { file: string; line: string }[],
): DiffIdeaCandidate | null => {
  if (!items.length) return null;
  const bullets = items
    .slice(0, 10)
    .map((i) => `- \`${i.file}\`: ${i.line.slice(0, 160)}`)
    .join("\n");
  const more = items.length > 10 ? `\n(+${items.length - 10} more)` : "";
  return {
    title: `Follow up on ${items.length} TODO${items.length > 1 ? "s" : ""} added in ${shortRepoName(repo)} PR #${prNumber}`,
    description: `PR: ${prUrl} — "${prTitle}"\n\nNew TODO/FIXME/XXX/HACK markers were introduced in this PR and should be tracked or resolved:\n\n${bullets}${more}`,
    repos: [shortRepoName(repo)],
    confidence: 0.55,
    dedup_key: `diff:todo:${repo}:${prNumber}`,
  };
};

const emitConsoleLogIdea = (
  repo: string,
  prUrl: string,
  prNumber: number,
  prTitle: string,
  items: { file: string; line: string }[],
): DiffIdeaCandidate | null => {
  if (!items.length) return null;
  const bullets = items
    .slice(0, 10)
    .map((i) => `- \`${i.file}\`: \`${i.line.slice(0, 160)}\``)
    .join("\n");
  const more = items.length > 10 ? `\n(+${items.length - 10} more)` : "";
  return {
    title: `Remove ${items.length} stray console.log${items.length > 1 ? "s" : ""} left in ${shortRepoName(repo)} PR #${prNumber}`,
    description: `PR: ${prUrl} — "${prTitle}"\n\nconsole.log/console.debug calls were added in this merged PR. Likely debugging leftovers — swap for the logger or delete:\n\n${bullets}${more}`,
    repos: [shortRepoName(repo)],
    confidence: 0.7,
    dedup_key: `diff:console-log:${repo}:${prNumber}`,
  };
};

const emitLargeFileIdea = (
  repo: string,
  file: string,
  lineCount: number,
): DiffIdeaCandidate => ({
  title: `Split large file \`${file}\` in ${shortRepoName(repo)} (${lineCount} lines)`,
  description: `\`${file}\` in ${repo} is ${lineCount} lines (threshold ${LARGE_FILE_THRESHOLD}) and was touched in the last 7 days — it's still actively changing, which is a good moment to split it before it grows further.`,
  repos: [shortRepoName(repo)],
  confidence: 0.5,
  dedup_key: `diff:large-file:${repo}:${file}`,
});

const emitServiceNearThresholdIdea = (
  repo: string,
  file: string,
  lineCount: number,
): DiffIdeaCandidate => ({
  title: `Service \`${file}\` in ${shortRepoName(repo)} nearing split threshold (${lineCount} lines)`,
  description: `\`${file}\` in ${repo} is ${lineCount} lines — between the warn threshold (${SERVICE_WARN_THRESHOLD}) and the split threshold (${LARGE_FILE_THRESHOLD}). It was modified in the last 7 days. Consider splitting before it crosses the line.`,
  repos: [shortRepoName(repo)],
  confidence: 0.4,
  dedup_key: `diff:service-near-threshold:${repo}:${file}`,
});

const analyzeTouchedFiles = (
  repo: string,
  touched: Set<string>,
): DiffIdeaCandidate[] => {
  const local = localRepoPath(repo);
  if (!local) return [];
  const out: DiffIdeaCandidate[] = [];
  for (const file of touched) {
    if (!isCodeFile(file)) continue;
    const abs = join(local, file);
    const n = countLines(abs);
    if (n === null) continue;
    if (n >= LARGE_FILE_THRESHOLD) {
      out.push(emitLargeFileIdea(repo, file, n));
    } else if (n >= SERVICE_WARN_THRESHOLD && /\.service\.ts$/.test(file)) {
      out.push(emitServiceNearThresholdIdea(repo, file, n));
    }
  }
  return out;
};

type ExportedSymbol = { repo: string; file: string; name: string };

// Scan for exported type/interface names under a set of candidate source roots
// relative to repoPath. Missing roots are skipped silently (grep exits non-zero).
const scanExportedSymbols = (
  repoPath: string,
  roots: string[] = ["src", "app", "pages", "helpers", "gpApi", "contracts"],
): ExportedSymbol[] => {
  const out: ExportedSymbol[] = [];
  const existingRoots = roots
    .map((r) => join(repoPath, r))
    .filter((p) => existsSync(p));
  if (!existingRoots.length) return out;
  const listCmd = [
    "grep",
    "-r",
    "-E",
    "-H",
    "-n",
    "--include=*.ts",
    "--include=*.tsx",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "--exclude-dir=build",
    "--exclude-dir=.next",
    "--exclude-dir=coverage",
    "--exclude-dir=e2e-tests",
    "^export (type|interface) [A-Z][A-Za-z0-9_]+",
    ...existingRoots,
  ];
  try {
    const raw = execFileSync(listCmd[0], listCmd.slice(1), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 50 * 1024 * 1024,
    });
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const m =
        /^([^:]+):\d+:export (?:type|interface) ([A-Z][A-Za-z0-9_]+)/.exec(
          line,
        );
      if (!m) continue;
      const file = m[1].replace(repoPath + "/", "");
      out.push({ repo: repoPath, file, name: m[2] });
    }
  } catch {
    // grep returns non-zero when no matches or the dir has no files. Ignore.
  }
  return out;
};

const analyzeSharedTypeDivergence = (
  watched: string[],
): DiffIdeaCandidate[] => {
  const apiRepo = watched.find((r) => shortRepoName(r) === "gp-api");
  const webRepo = watched.find((r) => shortRepoName(r) === "gp-webapp");
  if (!apiRepo || !webRepo) return [];
  const apiLocal = localRepoPath(apiRepo);
  const webLocal = localRepoPath(webRepo);
  if (!apiLocal || !webLocal) return [];

  const apiSyms = scanExportedSymbols(apiLocal);
  const webSyms = scanExportedSymbols(webLocal);
  if (!apiSyms.length || !webSyms.length) return [];

  // Names already in contracts package are fine. Load them from gp-api/contracts.
  const contractsDir = join(apiLocal, "contracts", "src");
  const contractNames = new Set<string>();
  if (existsSync(contractsDir)) {
    for (const s of scanExportedSymbols(join(apiLocal, "contracts"))) {
      contractNames.add(s.name);
    }
  }

  const apiByName = new Map<string, ExportedSymbol>();
  for (const s of apiSyms) {
    // skip types that live in contracts itself to avoid double-counting
    if (s.file.startsWith("contracts/")) continue;
    if (!apiByName.has(s.name)) apiByName.set(s.name, s);
  }
  const webByName = new Map<string, ExportedSymbol>();
  for (const s of webSyms) {
    if (!webByName.has(s.name)) webByName.set(s.name, s);
  }

  const out: DiffIdeaCandidate[] = [];
  const shared: { name: string; apiFile: string; webFile: string }[] = [];
  for (const [name, apiS] of apiByName) {
    if (contractNames.has(name)) continue;
    const webS = webByName.get(name);
    if (!webS) continue;
    shared.push({ name, apiFile: apiS.file, webFile: webS.file });
  }
  if (!shared.length) return out;
  const capped = shared.slice(0, 30);
  const bullets = capped
    .map(
      (s) =>
        `- \`${s.name}\` — gp-api \`${s.apiFile}\` vs gp-webapp \`${s.webFile}\``,
    )
    .join("\n");
  const more =
    shared.length > capped.length
      ? `\n(+${shared.length - capped.length} more)`
      : "";
  const dedupSeed = capped
    .map((s) => s.name)
    .sort()
    .join(",");
  out.push({
    title: `${shared.length} shared type${shared.length > 1 ? "s" : ""} defined in both gp-api and gp-webapp outside contracts`,
    description: `These exported type/interface names are declared in both repos but are not in \`@goodparty_org/contracts\`. They're likely candidates to migrate to the contracts package so both sides stay in sync:\n\n${bullets}${more}`,
    repos: ["gp-api", "gp-webapp"],
    confidence: 0.35,
    dedup_key: `diff:shared-types:${hash16(dedupSeed)}`,
  });
  return out;
};

export const generateDiffIdeas = async (
  opts: GenerateDiffOpts = {},
): Promise<GenerateDiffResult> => {
  const repos = getWatchedRepos();
  const since = opts.sinceDate ?? isoDateDaysAgo(7);
  const prLimit = opts.prLimit ?? 30;
  const verbose = !!opts.verbose;
  const candidates: DiffIdeaCandidate[] = [];

  for (const repo of repos) {
    const prs = gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--json",
      "number,title,url,mergedAt",
      "--limit",
      String(prLimit),
    ]) as any[] | null;
    if (!prs?.length) {
      if (verbose) console.log(`[diff] ${repo}: no merged PRs since ${since}`);
      continue;
    }
    if (verbose) console.log(`[diff] ${repo}: scanning ${prs.length} PR(s)`);

    const touchedThisWeek = new Set<string>();
    for (const pr of prs) {
      const diff = ghText(["pr", "diff", String(pr.number), "--repo", repo]);
      if (!diff) continue;
      const scan = scanDiff(diff);
      for (const f of scan.touchedFiles) touchedThisWeek.add(f);
      const todo = emitTodoIdea(repo, pr.url, pr.number, pr.title, scan.todos);
      if (todo) candidates.push(todo);
      const cl = emitConsoleLogIdea(
        repo,
        pr.url,
        pr.number,
        pr.title,
        scan.consoleLogs,
      );
      if (cl) candidates.push(cl);
    }
    for (const c of analyzeTouchedFiles(repo, touchedThisWeek)) {
      candidates.push(c);
    }
  }

  for (const c of analyzeSharedTypeDivergence(repos)) {
    candidates.push(c);
  }

  let emitted = 0;
  let skipped = 0;
  const newIds: string[] = [];
  for (const c of candidates) {
    const id = `idea-diff-${hash16(c.dedup_key)}`;
    if (ideas.get(id)) {
      skipped++;
      continue;
    }
    if (!opts.dryRun) {
      ideas.insert({
        id,
        title: c.title,
        description: c.description,
        source: "generator:diff",
        confidence: c.confidence,
        repos_guess: c.repos,
        status: "new",
        promoted_to: null,
      });
    }
    newIds.push(id);
    emitted++;
  }
  return { emitted, skipped, candidates, newIds };
};
