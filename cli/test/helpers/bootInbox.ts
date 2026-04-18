import { spawn, ChildProcess } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type BootInboxOpts = {
  dbPath: string;
  port: number;
  binPath?: string;
  readyTimeoutMs?: number;
};

export type BootedInbox = {
  url: string;
  proc: ChildProcess;
  close: () => Promise<void>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BIN = join(__dirname, "../../dist/index.js");

const waitForHealth = async (url: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `inbox-serve did not respond on ${url}/healthz within ${timeoutMs}ms (last err: ${String(lastErr)})`,
  );
};

export const bootInbox = async (opts: BootInboxOpts): Promise<BootedInbox> => {
  const bin = opts.binPath ?? DEFAULT_BIN;
  const url = `http://127.0.0.1:${opts.port}`;
  const proc = spawn(process.execPath, [bin, "inbox-serve"], {
    env: {
      ...process.env,
      COS_DB_PATH: opts.dbPath,
      COS_INBOX_PORT: String(opts.port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let earlyExitErr: Error | null = null;
  proc.once("exit", (code, sig) => {
    if (code !== 0)
      earlyExitErr = new Error(
        `inbox-serve exited early: code=${code} sig=${sig}`,
      );
  });

  try {
    await waitForHealth(url, opts.readyTimeoutMs ?? 10_000);
  } catch (e) {
    proc.kill("SIGKILL");
    if (earlyExitErr) throw earlyExitErr;
    throw e;
  }

  const close = async () => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    await Promise.race([
      once(proc, "exit"),
      new Promise((_, rej) =>
        setTimeout(() => {
          proc.kill("SIGKILL");
          rej(new Error("inbox-serve did not exit within 2s"));
        }, 2_000),
      ),
    ]).catch(() => undefined);
  };

  return { url, proc, close };
};
