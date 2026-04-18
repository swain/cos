import { z } from "zod";

export const WorkItemStatusSchema = z.enum([
  "queued",
  "in-progress",
  "blocked",
  "pr-open",
  "merged",
  "done",
  "abandoned",
]);
export type WorkItemStatus = z.infer<typeof WorkItemStatusSchema>;

export const WorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  acceptance_criteria: z.string(),
  repos: z.array(z.string()),
  priority: z.number().int().min(1).max(5),
  status: WorkItemStatusSchema,
  source: z.string(),
  depends_on: z.array(z.string()),
  session_id: z.string().nullable(),
  pr_urls: z.array(z.string()),
  worklog_path: z.string().nullable(),
  worktree_paths: z.record(z.string(), z.string()),
  needs_approval: z.boolean(),
  inbox_acked_at: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  completed_at: z.string().nullable(),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const IdeaStatusSchema = z.enum([
  "new",
  "promoted",
  "deferred",
  "killed",
]);
export type IdeaStatus = z.infer<typeof IdeaStatusSchema>;

export const IdeaSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  source: z.string(),
  confidence: z.number().min(0).max(1),
  repos_guess: z.array(z.string()),
  status: IdeaStatusSchema,
  promoted_to: z.string().nullable(),
  created_at: z.string(),
});
export type Idea = z.infer<typeof IdeaSchema>;

export const SignalStatusSchema = z.enum([
  "new",
  "triaged",
  "suppressed",
  "converted-to-idea",
  "converted-to-work-item",
]);
export type SignalStatus = z.infer<typeof SignalStatusSchema>;

export const SignalSchema = z.object({
  id: z.string(),
  source: z.string(),
  kind: z.string(),
  external_id: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: SignalStatusSchema,
  triaged_at: z.string().nullable(),
  created_at: z.string(),
});
export type Signal = z.infer<typeof SignalSchema>;

export const SessionStatusSchema = z.enum([
  "starting",
  "running",
  "idle",
  "completed",
  "failed",
  "killed",
  "stale",
  "archived",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionKindSchema = z.enum([
  "worker",
  "cron",
  "dialog",
  "meeting-prep",
]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionSchema = z.object({
  id: z.string(),
  work_item_id: z.string().nullable(),
  tmux_window: z.string().nullable(),
  kind: SessionKindSchema,
  status: SessionStatusSchema,
  current_step: z.string().nullable(),
  last_heartbeat: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  notes: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

export const UrgencySchema = z.enum(["urgent", "normal", "digest"]);
export type Urgency = z.infer<typeof UrgencySchema>;

export const NotificationSchema = z.object({
  id: z.string(),
  subject: z.string(),
  body: z.string(),
  urgency: UrgencySchema,
  related_ids: z.array(z.string()),
  pushed_at: z.string().nullable(),
  acked_at: z.string().nullable(),
  created_at: z.string(),
});
export type Notification = z.infer<typeof NotificationSchema>;

export const FollowupStatusSchema = z.enum([
  "open",
  "raised",
  "addressed",
  "dropped",
]);
export type FollowupStatus = z.infer<typeof FollowupStatusSchema>;

// Trigger forms: next-dialog | before-meeting:<name> | before-workitem:<wi-id> | after-date:<iso>
export const FollowupTriggerSchema = z
  .string()
  .refine(
    (s) =>
      s === "next-dialog" ||
      /^before-meeting:.+/.test(s) ||
      /^before-workitem:.+/.test(s) ||
      /^after-date:.+/.test(s),
    "trigger must be one of: next-dialog | before-meeting:<name> | before-workitem:<wi-id> | after-date:<iso>",
  );
export type FollowupTrigger = z.infer<typeof FollowupTriggerSchema>;

export const FollowupSchema = z.object({
  id: z.string(),
  topic: z.string(),
  context: z.string(),
  trigger: FollowupTriggerSchema,
  status: FollowupStatusSchema,
  created_at: z.string(),
  raised_at: z.string().nullable(),
});
export type Followup = z.infer<typeof FollowupSchema>;

export const RecurringTaskStatusSchema = z.enum(["ok", "failed"]);
export type RecurringTaskStatus = z.infer<typeof RecurringTaskStatusSchema>;

export const RecurringTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  cadence_hours: z.number().int().positive(),
  prompt_path: z.string(),
  enabled: z.boolean(),
  last_run_at: z.string().nullable(),
  next_run_at: z.string(),
  last_status: RecurringTaskStatusSchema.nullable(),
  last_notes: z.string().nullable(),
  created_at: z.string(),
});
export type RecurringTask = z.infer<typeof RecurringTaskSchema>;
