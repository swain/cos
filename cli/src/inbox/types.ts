import type { Urgency } from "../types.js";

export type Section =
  | "needsDecision"
  | "active"
  | "queue"
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
  | "recent-win";

export type InboxItem = {
  key: string;
  kind: ItemKind;
  id: string;
  section: Section;
  urgency: Urgency;
  subject: string;
  body: string;
  related_ids: string[];
  created_at: string;
  meta?: Record<string, string | number | null>;
};

export type InboxDashboard = {
  needsDecision: InboxItem[];
  active: InboxItem[];
  queue: InboxItem[];
  recentWins: InboxItem[];
  anomalies: InboxItem[];
  fyi: InboxItem[];
  digest: InboxItem[];
};

export const SECTION_ORDER: Section[] = [
  "needsDecision",
  "active",
  "queue",
  "recentWins",
  "anomalies",
  "fyi",
  "digest",
];

export const SECTION_TITLES: Record<Section, string> = {
  needsDecision: "NEEDS DECISION",
  active: "ACTIVE",
  queue: "QUEUE",
  recentWins: "RECENT WINS",
  anomalies: "ANOMALIES",
  fyi: "FYI",
  digest: "DIGEST",
};

export const SECTION_LIMIT = 10;

export const flattenDashboard = (d: InboxDashboard): InboxItem[] =>
  SECTION_ORDER.flatMap((s) => d[s]);
