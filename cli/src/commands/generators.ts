import chalk from "chalk";
import { generateAll } from "../generators/ai-native.js";

export const cmdGenerateAiNative = () => {
  const results = generateAll();
  let totalInserted = 0;
  let totalSkipped = 0;
  let totalParsed = 0;
  for (const r of results) {
    totalInserted += r.inserted.length;
    totalSkipped += r.skipped.length;
    totalParsed += r.parsed;
    const label = chalk.cyan(r.repo.padEnd(12));
    console.log(
      `${label} parsed=${r.parsed} inserted=${r.inserted.length} skipped=${r.skipped.length}`,
    );
    for (const s of r.skipped) {
      console.log(chalk.gray(`  - dim${s.number}: ${s.reason}`));
    }
  }
  console.log(
    chalk.green(
      `ai-native: ${totalInserted} new ideas (parsed ${totalParsed}, skipped ${totalSkipped})`,
    ),
  );
};
