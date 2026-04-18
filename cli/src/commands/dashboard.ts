import { spawn, spawnSync } from "node:child_process";
import { userInfo } from "node:os";
import chalk from "chalk";

const INBOX_URL = "http://127.0.0.1:4411";
const LABEL =
  process.env.COS_INBOX_LAUNCHD_LABEL ?? `com.${userInfo().username}.cos.inbox`;

type LoadState = "running" | "loaded" | "not-loaded";

const inspectLaunchd = (): LoadState => {
  const uid = process.getuid?.() ?? 0;
  const res = spawnSync("launchctl", ["print", `gui/${uid}/${LABEL}`], {
    encoding: "utf8",
  });
  if (res.status !== 0) return "not-loaded";
  return /^\s*state\s*=\s*running\b/m.test(res.stdout) ? "running" : "loaded";
};

const kickstart = (): boolean => {
  const uid = process.getuid?.() ?? 0;
  const res = spawnSync("launchctl", ["kickstart", `gui/${uid}/${LABEL}`], {
    stdio: "inherit",
  });
  return res.status === 0;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const waitForHealthz = async (timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${INBOX_URL}/healthz`);
      if (r.ok) return true;
    } catch {
      // server not up yet
    }
    await sleep(200);
  }
  return false;
};

export const cmdDashboard = async () => {
  if (process.platform !== "darwin") {
    console.error(
      chalk.red(
        `cos dashboard is only supported on macOS (launchd). Open ${INBOX_URL} manually if the inbox server is running.`,
      ),
    );
    process.exit(1);
  }

  const state = inspectLaunchd();
  if (state === "not-loaded") {
    console.error(
      chalk.red(
        `inbox launchd job '${LABEL}' is not loaded. Run install.sh to set up the inbox service.`,
      ),
    );
    process.exit(1);
  }

  if (state === "loaded") {
    console.log(chalk.gray(`inbox job '${LABEL}' is stopped — kickstarting…`));
    if (!kickstart()) {
      console.error(chalk.red(`failed to kickstart ${LABEL}`));
      process.exit(1);
    }
    const ok = await waitForHealthz(5_000);
    if (!ok) {
      console.error(
        chalk.red(
          `inbox did not respond to ${INBOX_URL}/healthz within 5s — check ~/.claude/cos/logs/inbox.err.log`,
        ),
      );
      process.exit(1);
    }
  }

  spawn("open", [INBOX_URL], { stdio: "ignore", detached: true }).unref();
  console.log(chalk.gray(`opened ${INBOX_URL}`));
};
