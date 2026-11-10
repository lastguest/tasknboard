import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const result = await build({
  entryPoints: ["src/embedded-main.tsx"], bundle: true, write: false,
  outdir: "dist-app", format: "iife", target: "es2022", minify: true,
  define: { __APP_VERSION__: JSON.stringify(version), "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "dataurl", ".svg": "dataurl" },
});
const js = result.outputFiles.find(file => file.path.endsWith(".js")).text.replace(/<\/script/gi, "<\\/script");
const css = result.outputFiles.find(file => file.path.endsWith(".css"))?.text ?? "";
await mkdir("dist-app", { recursive: true });
await writeFile("dist-app/index.html", `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TasknBoard</title><style>${css}</style></head><body><div id="root"></div><script>${js}</script></body></html>`);
