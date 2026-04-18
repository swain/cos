import type { Urgency } from "../types.js";

export type Band = "decision" | "fyi" | "digest";

export type ItemKind = "notification" | "work-item" | "signal" | "session";

export type InboxItem = {
  key: string;
  kind: ItemKind;
  id: string;
  band: Band;
  urgency: Urgency;
  subject: string;
  body: string;
  related_ids: string[];
  created_at: string;
};
