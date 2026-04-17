import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  splitting: false,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  outExtension: () => ({ js: ".js" }),
});
