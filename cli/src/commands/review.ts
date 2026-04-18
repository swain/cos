import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import chalk from "chalk";
import { getDb, ideas, notifications, recurring, workItems } from "../db.js";
import {
  COS_DIR,
  PRIORITIES_MD,
  PROMPTS_DIR,
  REVIEWS_DIR,
  WATCHED_REPOS_JSON,
  nowIso,
  parseJson,
  shortRepoName,
  watchedRepoName,
  type WatchedReposFile,
} from "../util.js";

type MergedPr = {
  number: number;
  title: string;
  url: string;
  mergedAt: string;
  author: string;
};

const getIsoWeek = (d: Date): { year: number; week: number } => {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(
    ((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { year: date.getUTCFullYear(), week: weekNo };
};

const fmtWeekId = (year: number, week: number) =>
  `${year}-W${String(week).padStart(2, "0")}`;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400_000).toISOString();

const getWatchedRepos = (): string[] => {
  if (!existsSync(WATCHED_REPOS_JSON)) return [];
  const cfg = parseJson<WatchedReposFile>(
    readFileSync(WATCHED_REPOS_JSON, "utf8"),
    {},
  );
  return (cfg.repos ?? []).map(watchedRepoName);
};

const fetchMergedPrs = (repo: string, since: string): MergedPr[] => {
  // gh pr list --state merged accepts a --search filter; use merged:>=<date>.
  try {
    const out = execFileSync(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--state",
        "merged",
        "--search",
        `merged:>=${since}`,
        "--limit",
        "100",
        "--json",
        "number,title,url,mergedAt,author",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const rows = JSON.parse(out.trim() || "[]") as any[];
    return rows.map((r) => ({
      number: r.number,
      title: r.title,
      url: r.url,
      mergedAt: r.mergedAt,
      author: r.author?.login ?? "",
    }));
  } catch (e: any) {
    console.error(
      chalk.yellow(
        `[review] gh pr list failed for ${repo}: ${e.message?.slice(0, 160)}`,
      ),
    );
    return [];
  }
};

const ACTIVE_STATUSES = new Set([
  "queued",
  "in-progress",
  "blocked",
  "pr-open",
]);

type ReviewData = {
  weekId: string;
  windowStart: string;
  generatedAt: string;
  shipped: Array<{ repo: string; prs: MergedPr[] }>;
  stalled: ReturnType<typeof workItems.list>;
  priorities: {
    exists: boolean;
    lastModified: string | null;
    daysSinceModified: number | null;
    excerpt: string;
  };
  ideasTrend: {
    createdThisWeek: number;
    createdLastWeek: number;
    promotedThisWeek: number;
    killedOrDeferredThisWeek: number;
    backlogNew: number;
  };
  cron: {
    ticksThisWeek: number;
    ticksExpected: number;
    longestGapMinutes: number;
    notificationsPushed: number;
    itemsDispatched: number;
  };
};

const collectReviewData = (opts: { now: Date }): ReviewData => {
  const { now } = opts;
  const { year, week } = getIsoWeek(now);
  const weekId = fmtWeekId(year, week);
  const windowStartDate = new Date(now.getTime() - 7 * 86400_000);
  const windowStart = windowStartDate.toISOString();
  const sinceDate = windowStart.slice(0, 10);

  const repos = getWatchedRepos();
  const shipped: ReviewData["shipped"] = repos.map((repo) => ({
    repo,
    prs: fetchMergedPrs(repo, sinceDate),
  }));

  const staleCutoff = daysAgo(3);
  const stalled = workItems
    .list()
    .filter((w) => ACTIVE_STATUSES.has(w.status) && w.updated_at < staleCutoff);

  let prioritiesExcerpt = "_priorities.md not found_";
  let lastModified: string | null = null;
  let daysSinceModified: number | null = null;
  if (existsSync(PRIORITIES_MD)) {
    const raw = readFileSync(PRIORITIES_MD, "utf8");
    const mtime = statSync(PRIORITIES_MD).mtime;
    lastModified = mtime.toISOString();
    daysSinceModified = Math.floor(
      (now.getTime() - mtime.getTime()) / 86400_000,
    );
    const lines = raw.split("\n");
    prioritiesExcerpt =
      lines.slice(0, 60).join("\n") +
      (lines.length > 60
        ? "\n\n_…truncated. See ~/.claude/cos/priorities.md._"
        : "");
  }

  const allIdeas = ideas.list();
  const lastWeekStart = new Date(now.getTime() - 14 * 86400_000).toISOString();
  const createdThisWeek = allIdeas.filter(
    (i) => i.created_at >= windowStart,
  ).length;
  const createdLastWeek = allIdeas.filter(
    (i) => i.created_at >= lastWeekStart && i.created_at < windowStart,
  ).length;
  const promotedThisWeek = allIdeas.filter(
    (i) => i.status === "promoted" && i.created_at >= windowStart,
  ).length;
  const killedOrDeferredThisWeek = allIdeas.filter(
    (i) =>
      (i.status === "killed" || i.status === "deferred") &&
      i.created_at >= windowStart,
  ).length;
  const backlogNew = allIdeas.filter((i) => i.status === "new").length;

  const db = getDb();
  const tickRows = db
    .prepare(
      `SELECT tick_at, items_dispatched, notifications_sent
         FROM cos_log
        WHERE tick_at >= ?
        ORDER BY tick_at ASC`,
    )
    .all(windowStart) as Array<{
    tick_at: string;
    items_dispatched: number;
    notifications_sent: number;
  }>;
  let longestGapMs = 0;
  for (let i = 1; i < tickRows.length; i++) {
    const gap =
      new Date(tickRows[i].tick_at).getTime() -
      new Date(tickRows[i - 1].tick_at).getTime();
    if (gap > longestGapMs) longestGapMs = gap;
  }
  const itemsDispatched = tickRows.reduce(
    (s, r) => s + (r.items_dispatched || 0),
    0,
  );

  const notifPushed = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE pushed_at IS NOT NULL AND pushed_at >= ?`,
    )
    .get(windowStart) as { n: number };

  return {
    weekId,
    windowStart,
    generatedAt: now.toISOString(),
    shipped,
    stalled,
    priorities: {
      exists: existsSync(PRIORITIES_MD),
      lastModified,
      daysSinceModified,
      excerpt: prioritiesExcerpt,
    },
    ideasTrend: {
      createdThisWeek,
      createdLastWeek,
      promotedThisWeek,
      killedOrDeferredThisWeek,
      backlogNew,
    },
    cron: {
      ticksThisWeek: tickRows.length,
      ticksExpected: 7 * 24 * 4,
      longestGapMinutes: Math.round(longestGapMs / 60000),
      notificationsPushed: notifPushed.n,
      itemsDispatched,
    },
  };
};

const renderReviewMarkdown = (d: ReviewData): string => {
  const out: string[] = [];
  out.push(`# Weekly review — ${d.weekId}`);
  out.push("");
  out.push(
    `_Generated ${d.generatedAt} · rolling 7-day window since ${d.windowStart}_`,
  );
  out.push("");

  const totalShipped = d.shipped.reduce((s, r) => s + r.prs.length, 0);
  out.push(`## What shipped (${totalShipped} PRs merged)`);
  out.push("");
  const nonEmpty = d.shipped.filter((r) => r.prs.length > 0);
  if (!nonEmpty.length) {
    out.push("_No merged PRs detected across watched repos._");
    out.push("");
  } else {
    for (const { repo, prs } of nonEmpty) {
      out.push(`### ${shortRepoName(repo)} (${prs.length})`);
      out.push("");
      const sorted = [...prs].sort((a, b) =>
        a.mergedAt < b.mergedAt ? 1 : -1,
      );
      for (const pr of sorted) {
        const day = pr.mergedAt.slice(0, 10);
        out.push(
          `- ${day} [#${pr.number}](${pr.url}) **${pr.title}** _${pr.author}_`,
        );
      }
      out.push("");
    }
    const empty = d.shipped.filter((r) => r.prs.length === 0);
    if (empty.length) {
      out.push(
        `_Quiet this week: ${empty
          .map((r) => shortRepoName(r.repo))
          .join(", ")}._`,
      );
      out.push("");
    }
  }

  out.push(`## What stalled (${d.stalled.length} items > 3 days idle)`);
  out.push("");
  if (!d.stalled.length) {
    out.push("_Nothing idle > 3 days. Queue is healthy._");
    out.push("");
  } else {
    for (const wi of d.stalled) {
      const age = Math.floor(
        (Date.now() - new Date(wi.updated_at).getTime()) / 86400_000,
      );
      out.push(
        `- \`${wi.id}\` **P${wi.priority}** ${wi.title} — _${wi.status}, ${age}d since update_`,
      );
    }
    out.push("");
  }

  out.push("## Drift from priorities");
  out.push("");
  if (!d.priorities.exists) {
    out.push("_priorities.md not found._");
    out.push("");
  } else {
    out.push(
      `_Last modified ${d.priorities.lastModified} (${d.priorities.daysSinceModified}d ago)._`,
    );
    out.push("");
    out.push("```markdown");
    out.push(d.priorities.excerpt);
    out.push("```");
    out.push("");
    out.push(
      "**Eyeball check:** do the shipped PRs and stalled items above match what priorities.md says should matter?",
    );
    out.push("");
  }

  const trend = d.ideasTrend;
  const delta = trend.createdThisWeek - trend.createdLastWeek;
  const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "→";
  out.push("## Idea backlog trend");
  out.push("");
  out.push(
    `- New this week: **${trend.createdThisWeek}** (last week: ${trend.createdLastWeek}, ${arrow} ${delta >= 0 ? "+" : ""}${delta})`,
  );
  out.push(`- Promoted this week: **${trend.promotedThisWeek}**`);
  out.push(
    `- Killed/deferred this week: **${trend.killedOrDeferredThisWeek}**`,
  );
  out.push(`- Current backlog (status=new): **${trend.backlogNew}**`);
  out.push("");

  const cron = d.cron;
  const tickPct = Math.round(
    (cron.ticksThisWeek / Math.max(1, cron.ticksExpected)) * 100,
  );
  out.push("## Cron health");
  out.push("");
  out.push(
    `- Ticks run: **${cron.ticksThisWeek}** / ${cron.ticksExpected} expected (${tickPct}%)`,
  );
  out.push(
    `- Longest gap between ticks: **${cron.longestGapMinutes} min** (normal: 15)`,
  );
  out.push(`- Notifications pushed: **${cron.notificationsPushed}**`);
  out.push(`- Work items dispatched: **${cron.itemsDispatched}**`);
  out.push("");

  out.push("---");
  out.push("");
  out.push("— Po");
  out.push("");

  return out.join("\n");
};

const WEEKLY_RECURRING_ID = "rec-weekly-review";

const nextFridayAfternoon = (now: Date): Date => {
  // Friday = 5 in getDay() (Sunday=0). Target: Friday 16:00 local time.
  const target = new Date(now);
  target.setHours(16, 0, 0, 0);
  const daysUntilFriday = (5 - target.getDay() + 7) % 7;
  if (daysUntilFriday === 0 && target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 7);
  } else {
    target.setDate(target.getDate() + daysUntilFriday);
  }
  return target;
};

export const ensureWeeklyRecurring = (
  opts: { now?: Date; silent?: boolean } = {},
): boolean => {
  if (recurring.get(WEEKLY_RECURRING_ID)) return false;
  const promptPath = join(PROMPTS_DIR, "weekly-review.md");
  if (!existsSync(promptPath)) {
    if (!opts.silent) {
      console.error(
        chalk.yellow(
          `[review] weekly-review prompt not found at ${promptPath} — skipping recurring task seed`,
        ),
      );
    }
    return false;
  }
  const now = opts.now ?? new Date();
  const firstRun = nextFridayAfternoon(now).toISOString();
  recurring.insert({
    id: WEEKLY_RECURRING_ID,
    title: "Weekly review digest",
    cadence_hours: 168,
    prompt_path: promptPath,
    enabled: true,
    next_run_at: firstRun,
  });
  if (!opts.silent) {
    console.error(
      chalk.gray(
        `[review] seeded ${WEEKLY_RECURRING_ID} (first run ${firstRun})`,
      ),
    );
  }
  return true;
};

export const cmdReviewWeek = (
  opts: {
    notify?: boolean;
    stdout?: boolean;
  } = {},
) => {
  const now = new Date();
  const data = collectReviewData({ now });
  const md = renderReviewMarkdown(data);

  if (opts.stdout) {
    process.stdout.write(md);
    return;
  }

  mkdirSync(REVIEWS_DIR, { recursive: true });
  const outPath = join(REVIEWS_DIR, `${data.weekId}.md`);
  writeFileSync(outPath, md);
  console.log(chalk.green("wrote"), outPath);

  if (opts.notify !== false) {
    const totalShipped = data.shipped.reduce((s, r) => s + r.prs.length, 0);
    const id = `notif-${ulid()}`;
    notifications.insert({
      id,
      subject: `Weekly review ready — ${data.weekId}`,
      body: `${totalShipped} PRs shipped, ${data.stalled.length} stalled, ${data.ideasTrend.backlogNew} ideas in backlog. Full digest: ${outPath}`,
      urgency: "normal",
      related_ids: [],
      pushed_at: null,
    });
    console.log(chalk.gray("notification queued"), id);
  }

  ensureWeeklyRecurring({ now });
};
