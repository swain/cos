import { tmpdir } from "node:os";
import { join } from "node:path";

export const E2E_PORT = Number(process.env.COS_E2E_PORT) || 4412;
export const E2E_DB_PATH =
  process.env.COS_E2E_DB_PATH ??
  join(tmpdir(), `cos-inbox-e2e-${process.pid}.db`);
export const E2E_BASE_URL = `http://127.0.0.1:${E2E_PORT}`;
