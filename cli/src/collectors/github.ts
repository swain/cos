import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import {
  WATCHED_REPOS_JSON,
  parseJson,
  watchedRepoName,
  type WatchedReposFile,
} from "../util.js";

export type CollectedSignal = {
  source: "github";
  kind: string;
  external_id: string | null;
  payload: Record<string, unknown>;
};

const gh = (args: string[]): any => {
  try {
    const out = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.trim() ? JSON.parse(out) : null;
  } catch (e: any) {
    console.error(
      `[github] gh ${args.join(" ")} failed: ${e.message?.slice(0, 200)}`,
    );
    return null;
  }
};

const getWatchedRepos = (): string[] => {
  if (!existsSync(WATCHED_REPOS_JSON)) return [];
  const cfg = parseJson<WatchedReposFile>(
    readFileSync(WATCHED_REPOS_JSON, "utf8"),
    {},
  );
  return (cfg.repos ?? []).map(watchedRepoName);
};

export const collectGithubSignals = async (): Promise<CollectedSignal[]> => {
  const out: CollectedSignal[] = [];
  const repos = getWatchedRepos();
  if (!repos.length) return out;

  // 1) PRs where I'm a requested reviewer (across all repos at once via search)
  const reviewReqd = gh([
    "search",
    "prs",
    "--review-requested=@me",
    "--state=open",
    "--json=url,title,number,repository,author,updatedAt",
  ]) as any[] | null;
  for (const pr of reviewReqd ?? []) {
    const repoName = pr.repository?.nameWithOwner ?? pr.repository?.name;
    if (
      repos.length &&
      !repos.some((r) => repoName?.endsWith(r) || repoName === r)
    )
      continue;
    out.push({
      source: "github",
      kind: "pr-needs-my-review",
      external_id: pr.url,
      payload: {
        title: pr.title,
        number: pr.number,
        repo: repoName,
        author: pr.author?.login,
        updated_at: pr.updatedAt,
      },
    });
  }

  // 2) My open PRs — check CI status + comment count
  const mine = gh([
    "search",
    "prs",
    "--author=@me",
    "--state=open",
    "--json=url,title,number,repository,updatedAt",
  ]) as any[] | null;
  for (const pr of mine ?? []) {
    const repoName = pr.repository?.nameWithOwner ?? pr.repository?.name;
    if (
      repos.length &&
      !repos.some((r) => repoName?.endsWith(r) || repoName === r)
    )
      continue;
    const detail = gh([
      "pr",
      "view",
      String(pr.url),
      "--json=statusCheckRollup,comments,reviews,url,title,mergeable",
    ]) as any;
    if (!detail) continue;
    const checks = (detail.statusCheckRollup ?? []) as any[];
    const anyFail = checks.some((c: any) =>
      ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(c.conclusion),
    );
    if (anyFail) {
      out.push({
        source: "github",
        kind: "pr-ci-failed",
        external_id: pr.url,
        payload: {
          title: pr.title,
          number: pr.number,
          repo: repoName,
          failed: checks
            .filter((c: any) =>
              ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT"].includes(
                c.conclusion,
              ),
            )
            .map((c: any) => c.name),
        },
      });
    }
    if (
      (detail.comments ?? []).length > 0 ||
      (detail.reviews ?? []).length > 0
    ) {
      out.push({
        source: "github",
        kind: "pr-comments-on-mine",
        external_id: `${pr.url}#comments`,
        payload: {
          title: pr.title,
          number: pr.number,
          repo: repoName,
          url: pr.url,
          comment_count: detail.comments.length,
          review_count: detail.reviews.length,
        },
      });
    }
    if (detail.mergeable === "CONFLICTING") {
      out.push({
        source: "github",
        kind: "pr-merge-conflict",
        external_id: `${pr.url}#conflict`,
        payload: {
          title: pr.title,
          number: pr.number,
          repo: repoName,
          url: pr.url,
        },
      });
    }
  }

  // (Self-build item: add pr-merged detection. gh search prs doesn't accept
  // a date comparator on --merged, so we'll use a per-repo `gh pr list --state=merged`
  // approach in a follow-up.)

  return out;
};
