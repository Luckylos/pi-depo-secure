import { defineConfig } from "tsup";

export default defineConfig({
  entry: { cli: "src/cli.ts", "pi-depo-sync": "extensions/pi-depo-sync.ts" },
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  splitting: false,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
