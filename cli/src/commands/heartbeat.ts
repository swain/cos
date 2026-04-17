import chalk from "chalk";
import { sessions } from "../db.js";

export const cmdHeartbeat = (sessionId: string, step?: string) => {
  const s = sessions.get(sessionId);
  if (!s) {
    console.error(chalk.red(`session not found: ${sessionId}`));
    process.exit(2);
  }
  sessions.heartbeat(sessionId, step);
  console.log(chalk.gray("heartbeat"), sessionId, step ?? "");
};
