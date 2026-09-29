import { chmodSync } from "node:fs";
import { build } from "esbuild";

// Dependencies stay in node_modules; only the CLI and server modules are bundled.
const options = {
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node24",
  jsx: "automatic",
  logLevel: "warning",
};
await build({
  ...options,
  entryPoints: ["cli/main.tsx"],
  outfile: "dist-cli/tasknboard.mjs",
  banner: {
    js: "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning",
  },
});
// The interface alone, for the terminal rendering tests.
await build({
  ...options,
  entryPoints: ["cli/App.tsx"],
  outfile: "dist-cli/app.mjs",
});
chmodSync("dist-cli/tasknboard.mjs", 0o755);
