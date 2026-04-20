import type { Urgency, TriageVerdict } from "../types.js";

// Top-level dashboard surface is two sections:
// - Review: things that block the user's attention
// - FYI: things the user can glance at or ignore
export type Section = "review" | "fyi";

export type ItemKind =
  | "notification"
  | "work-item"
  | "signal"
  | "session"
  | "worker"
  | "queue-item"
  | "pr-review"
  | "blocked-item"
  | "recent-win"
  | "idea";

export type IdeaMeta = {
  verdict: TriageVerdict;
  rationale: string;
  score: number;
  confidence: number;
  repos_guess: string[];
  // Parsed out of titles shaped like `[ai-native:<repo>:dim<N>] <rest>`.
  // Lets the renderer move the technical prefix out of the title area and
  // into the muted meta line while keeping the title itself readable.
  sourceTag: string | null;
};

export type InboxItem = {
  key: string;
  kind: ItemKind;
  id: string;
  // Human-friendly label preferred for display (e.g. `wi-42-foo`). Falls back
  // to `id` when unset — sessions/signals/notifications have no display form.
  displayLabel?: string;
  section: Section;
  urgency: Urgency;
  subject: string;
  body: string;
  related_ids: string[];
  created_at: string;
  meta?: Record<string, string | number | null>;
  ideaMeta?: IdeaMeta;
};

// Dashboard is two visible sections + two sidecars:
// - recentWins: rendered collapsed inside FYI ("N shipped in last 24h")
// - triagedIdeasCount: shown as a muted "N triaged ideas — browse" line
//   so the sweep of suggest-promote/suggest-kill verdicts is one click away
//   without crowding the attention surface
export type InboxDashboard = {
  review: InboxItem[];
  fyi: InboxItem[];
  recentWins: InboxItem[];
  triagedIdeasCount: number;
};

export type IdeasSectionStats = {
  topN: number;
  scoredTotal: number;
  unscoredTotal: number;
};

export const SECTION_ORDER: Section[] = ["review", "fyi"];

export const SECTION_TITLES: Record<Section, string> = {
  review: "Review",
  fyi: "FYI",
};

export const SECTION_LIMIT = 10;
export const IDEAS_TOP_N = 8;

// FYI items older than this disappear from the surface automatically.
// Manual mark-read still works — this is the fallback for rows the user
// never touched.
export const FYI_AUTO_READ_MS = 3 * 24 * 60 * 60 * 1000;

export const flattenDashboard = (d: InboxDashboard): InboxItem[] => [
  ...d.review,
  ...d.fyi,
  ...d.recentWins,
];
