import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { HOME } from "../util.js";
import { ideas } from "../db.js";

export const EVAL_REPOS = [
  "gp-api",
  "gp-webapp",
  "election-api",
  "people-api",
  "ops",
] as const;

export const EVAL_DIR = join(HOME, "Repos/thegoodparty");

const evalPathFor = (repo: string) =>
  join(EVAL_DIR, `ai-native-evaluation-${repo}.md`);

export type ParsedDimension = {
  number: number;
  dimension: string;
  rating: string;
  fix: string;
};

const SEPARATOR_CELL_RE = /^-+$/;

export const parseExecutiveSummaryTable = (md: string): ParsedDimension[] => {
  const lines = md.split(/\r?\n/);
  const out: ParsedDimension[] = [];
  let inTable = false;
  let headerCols: string[] | null = null;

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.startsWith("|")) {
      if (inTable) break;
      continue;
    }
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    if (cells.every((c) => SEPARATOR_CELL_RE.test(c))) continue;

    if (!inTable) {
      const looksLikeHeader =
        cells[0] === "#" &&
        /dimension/i.test(cells[1] ?? "") &&
        /highest-leverage/i.test(cells[cells.length - 1] ?? "");
      if (!looksLikeHeader) continue;
      headerCols = cells;
      inTable = true;
      continue;
    }

    const num = parseInt(cells[0], 10);
    if (!Number.isFinite(num)) break;
    const fix = cells[cells.length - 1] ?? "";
    const rating = (cells[2] ?? "").replace(/\*\*/g, "").trim();
    const dimension = cells[1] ?? "";
    if (!dimension || !fix) continue;
    out.push({ number: num, dimension, rating, fix });
  }
  void headerCols;
  return out;
};

const cleanDimension = (raw: string): string =>
  raw
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

const firstSentence = (s: string): string => {
  const cleaned = s.replace(/\s+/g, " ").trim();
  const m = cleaned.match(/^(.+?[.!?])(\s|$)/);
  const short = m ? m[1] : cleaned;
  return short.length > 140 ? short.slice(0, 137) + "..." : short;
};

const CONCRETE_VERBS =
  /\b(add|create|split|migrate|rename|move|delete|replace|promote|commit|strip|gitignore|collapse|extract|split|tighten|adopt|restore|initialize|remove|vendor|document)\b/i;

export const isConcreteFix = (fix: string): boolean => {
  const hasBacktick = /`[^`]+`/.test(fix);
  const hasSpecificVerb = CONCRETE_VERBS.test(fix);
  return hasBacktick && hasSpecificVerb;
};

const dedupeKey = (repo: string, dimNumber: number): string =>
  `[ai-native:${repo}:dim${dimNumber}]`;

const within30Days = (iso: string): boolean => {
  const created = new Date(iso + (iso.includes("T") ? "" : "Z")).getTime();
  if (!Number.isFinite(created)) return false;
  return Date.now() - created < 30 * 24 * 3600 * 1000;
};

export type GenerateResult = {
  repo: string;
  evalPath: string;
  parsed: number;
  inserted: string[];
  skipped: Array<{ repo: string; number: number; reason: string }>;
};

export const generateForRepo = (repo: string): GenerateResult => {
  const evalPath = evalPathFor(repo);
  const res: GenerateResult = {
    repo,
    evalPath,
    parsed: 0,
    inserted: [],
    skipped: [],
  };
  if (!existsSync(evalPath)) {
    res.skipped.push({
      repo,
      number: 0,
      reason: `eval doc missing: ${evalPath}`,
    });
    return res;
  }
  const md = readFileSync(evalPath, "utf8");
  const rows = parseExecutiveSummaryTable(md);
  res.parsed = rows.length;

  const existing = ideas
    .list()
    .filter((i) => i.source === "generator:ai-native");

  for (const row of rows) {
    const key = dedupeKey(repo, row.number);
    const blocker = existing.find(
      (i) =>
        i.title.startsWith(key) &&
        (i.status === "new" || i.status === "promoted") &&
        within30Days(i.created_at),
    );
    if (blocker) {
      res.skipped.push({
        repo,
        number: row.number,
        reason: `dedupe: existing ${blocker.status} idea ${blocker.id}`,
      });
      continue;
    }

    const dim = cleanDimension(row.dimension);
    const summary = firstSentence(row.fix);
    const title = `${key} ${dim}: ${summary}`;
    const description = [
      `Highest-leverage fix from ${repo} AI-native evaluation (${row.rating || "unrated"}).`,
      ``,
      `Dimension ${row.number}: ${dim}`,
      ``,
      row.fix,
      ``,
      `Source: ${evalPath}`,
    ].join("\n");

    const confidence = isConcreteFix(row.fix) ? 0.8 : 0.6;
    const id = `idea-${ulid()}`;
    ideas.insert({
      id,
      title,
      description,
      source: "generator:ai-native",
      confidence,
      repos_guess: [repo],
      status: "new",
      promoted_to: null,
    });
    res.inserted.push(id);
  }
  return res;
};

export const generateAll = (): GenerateResult[] =>
  EVAL_REPOS.map((r) => generateForRepo(r));
