import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
const { version } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:4310",
      "/files": "http://127.0.0.1:4310",
    },
  },
  build: { target: "es2022" },
});
