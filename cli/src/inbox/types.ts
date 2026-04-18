import type { Urgency, TriageVerdict } from "../types.js";

export type Section =
  | "needsDecision"
  | "active"
  | "queue"
  | "ideas"
  | "recentWins"
  | "anomalies"
  | "fyi"
  | "digest";

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

export type InboxDashboard = {
  needsDecision: InboxItem[];
  active: InboxItem[];
  queue: InboxItem[];
  ideas: InboxItem[];
  recentWins: InboxItem[];
  anomalies: InboxItem[];
  fyi: InboxItem[];
  digest: InboxItem[];
};

// IDEAS section state: how many are scored vs unscored and the top-N cap.
// Separate from InboxDashboard so the renderer can show "show N more" with
// both the trimmed count and the unscored-awaiting-triage count.
export type IdeasSectionStats = {
  topN: number;
  scoredTotal: number;
  unscoredTotal: number;
};

export const SECTION_ORDER: Section[] = [
  "needsDecision",
  "active",
  "queue",
  "ideas",
  "recentWins",
  "anomalies",
  "fyi",
  "digest",
];

export const SECTION_TITLES: Record<Section, string> = {
  needsDecision: "NEEDS DECISION",
  active: "ACTIVE",
  queue: "QUEUE",
  ideas: "IDEAS",
  recentWins: "RECENT WINS",
  anomalies: "ANOMALIES",
  fyi: "FYI",
  digest: "DIGEST",
};

export const SECTION_LIMIT = 10;
export const IDEAS_TOP_N = 8;

export const flattenDashboard = (d: InboxDashboard): InboxItem[] =>
  SECTION_ORDER.flatMap((s) => d[s]);
