import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ulid } from "ulid";
import { COMMITMENTS_MD } from "./util.js";

export type Commitment = {
  id: string;
  who: string;
  what: string;
  due: string | null;
  source: string | null;
  added: string;
  done: boolean;
};

const LINE_RE =
  /^- \[([ x])\] (c-[A-Z0-9]+) \| ([^|]+) \| ([^|]+?)((?: \| due:[^|]+)?)((?: \| src:[^|]+)?) \| added:(\d{4}-\d{2}-\d{2})\s*$/;

export const parseLine = (line: string): Commitment | null => {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  return {
    done: m[1] === "x",
    id: m[2],
    who: m[3].trim(),
    what: m[4].trim(),
    due: m[5] ? m[5].replace(" | due:", "").trim() : null,
    source: m[6] ? m[6].replace(" | src:", "").trim() : null,
    added: m[7],
  };
};

export const formatLine = (c: Commitment): string => {
  const parts = [`- [${c.done ? "x" : " "}] ${c.id}`, c.who, c.what];
  let line = parts.join(" | ");
  if (c.due) line += ` | due:${c.due}`;
  if (c.source) line += ` | src:${c.source}`;
  line += ` | added:${c.added}`;
  return line;
};

export const parseLedger = (content: string): Commitment[] =>
  content
    .split("\n")
    .map(parseLine)
    .filter((c): c is Commitment => c !== null);

export const serializeLedger = (items: Commitment[]): string => {
  const active = items.filter((c) => !c.done).map(formatLine);
  const archive = items.filter((c) => c.done).map(formatLine);
  return [
    "# Commitments",
    "",
    "## Active",
    "",
    ...active,
    "",
    "## Archive",
    "",
    ...archive,
    "",
  ].join("\n");
};

export const loadLedger = (): Commitment[] => {
  if (!existsSync(COMMITMENTS_MD)) return [];
  return parseLedger(readFileSync(COMMITMENTS_MD, "utf8"));
};

export const saveLedger = (items: Commitment[]) => {
  writeFileSync(COMMITMENTS_MD, serializeLedger(items));
};

export const newCommitmentId = (): string => `c-${ulid().slice(-6)}`;
