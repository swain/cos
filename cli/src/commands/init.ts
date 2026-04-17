import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import chalk from "chalk";
import { getDb } from "../db.js";
import {
  COS_DIR,
  STATUS_MD,
  DECISIONS_LOG,
  CONFIG_JSON,
  WATCHED_REPOS_JSON,
} from "../util.js";

export const cmdInit = () => {
  mkdirSync(COS_DIR, { recursive: true });
  for (const d of [
    "logs",
    "worklogs",
    "meetings",
    "prompts",
    "bin",
    "launchd",
  ]) {
    mkdirSync(join(COS_DIR, d), { recursive: true });
  }
  getDb();

  if (!existsSync(STATUS_MD)) {
    writeFileSync(
      STATUS_MD,
      "# COS Status\n\n_Not yet initialized. The first cron tick will populate this._\n",
    );
  }
  if (!existsSync(DECISIONS_LOG)) writeFileSync(DECISIONS_LOG, "");
  if (!existsSync(CONFIG_JSON)) {
    writeFileSync(
      CONFIG_JSON,
      JSON.stringify(
        {
          dispatch_paused: true,
          daily_worker_cap: 8,
          stale_heartbeat_minutes: 20,
          auto_dispatch_max_priority: 3,
        },
        null,
        2,
      ),
    );
  }
  if (!existsSync(WATCHED_REPOS_JSON)) {
    writeFileSync(
      WATCHED_REPOS_JSON,
      JSON.stringify(
        {
          repos: [
            "thegoodparty/gp-api",
            "thegoodparty/gp-webapp",
            "thegoodparty/election-api",
            "thegoodparty/people-api",
            "thegoodparty/gp-ai-projects",
            "thegoodparty/serve-ops",
          ],
          default_base_branch: "develop",
        },
        null,
        2,
      ),
    );
  }
  console.log(chalk.green("COS initialized at"), COS_DIR);
};
