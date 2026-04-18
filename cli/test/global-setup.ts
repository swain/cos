import { existsSync, rmSync } from "node:fs";
import { bootInbox, type BootedInbox } from "./helpers/bootInbox.js";
import { E2E_DB_PATH, E2E_PORT } from "./helpers/env.js";

let booted: BootedInbox | null = null;

export default async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${E2E_DB_PATH}${suffix}`;
    if (existsSync(p)) rmSync(p);
  }

  booted = await bootInbox({ dbPath: E2E_DB_PATH, port: E2E_PORT });

  return async () => {
    if (booted) await booted.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = `${E2E_DB_PATH}${suffix}`;
      if (existsSync(p)) rmSync(p, { force: true });
    }
  };
};
