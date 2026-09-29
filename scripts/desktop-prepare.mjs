import { createHash } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = "v24.14.0";
const platform = process.platform;
const arch = process.arch;
const isMacArm64 = platform === "darwin" && arch === "arm64";
const isWindowsX64 = platform === "win32" && arch === "x64";
const nativeTarget = isWindowsX64
  ? "x86_64-pc-windows-msvc"
  : "aarch64-apple-darwin";
const requestedTargets = [
  process.env.TAURI_ENV_TARGET_TRIPLE,
  process.env.CARGO_BUILD_TARGET,
].filter(Boolean);

for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (arg === "--target") {
    const target = process.argv[i + 1];
    if (!target || target.startsWith("--")) {
      throw new Error("The --target option requires a target triple.");
    }
    requestedTargets.push(target);
    i += 1;
  } else if (arg.startsWith("--target=")) {
    requestedTargets.push(arg.slice("--target=".length));
  }
}

if (!isMacArm64 && !isWindowsX64) {
  throw new Error(
    `Desktop packaging supports macOS arm64 and Windows x64; found ${platform}-${arch}.`,
  );
}
for (const target of requestedTargets) {
  if (target !== nativeTarget) {
    throw new Error(
      `Desktop packaging supports native ${nativeTarget} only; requested ${target}.`,
    );
  }
}

const archiveName = isWindowsX64
  ? `node-${version}-win-x64.zip`
  : `node-${version}-darwin-arm64.tar.gz`;
const archiveUrl = `https://nodejs.org/dist/${version}/${archiveName}`;
const checksumsUrl = `https://nodejs.org/dist/${version}/SHASUMS256.txt`;
const resourcesDir = join(root, "src-tauri", "resources");
const cacheDir = join(root, ".desktop-cache");
const distDir = join(root, "dist");
const serverEntry = join(root, "server", "http.mjs");
const tempDir = await mkdtemp(join(tmpdir(), "tasknboard-desktop-"));

async function fetchOfficial(url) {
  const response = await fetch(url);
  if (!response.ok || !response.url.startsWith("https://nodejs.org/")) {
    throw new Error(`Could not download the official Node.js file: ${url}`);
  }
  return response;
}

try {
  await access(join(distDir, "index.html"));
  const checksumsResponse = await fetchOfficial(checksumsUrl);
  const checksums = await checksumsResponse.text();
  const checksumLine = checksums
    .split(/\r?\n/)
    .find((line) => line.trim().endsWith(` ${archiveName}`));
  const expectedSha256 = checksumLine?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || "")) {
    throw new Error(`Official SHASUMS256.txt has no checksum for ${archiveName}.`);
  }

  await mkdir(cacheDir, { recursive: true });
  const archivePath = join(cacheDir, archiveName);
  const downloadedArchivePath = join(tempDir, archiveName);
  let actualSha256;
  try {
    actualSha256 = createHash("sha256")
      .update(await readFile(archivePath))
      .digest("hex");
  } catch {
    actualSha256 = "";
  }
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    await rm(archivePath, { force: true });
    const archiveResponse = await fetchOfficial(archiveUrl);
    await pipeline(archiveResponse.body, createWriteStream(downloadedArchivePath));
    actualSha256 = createHash("sha256")
      .update(await readFile(downloadedArchivePath))
      .digest("hex");
    if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
      throw new Error(
        `Node.js archive checksum mismatch: expected ${expectedSha256}, got ${actualSha256}.`,
      );
    }
    await copyFile(downloadedArchivePath, archivePath);
  }

  const extractedDir = join(tempDir, "extracted");
  await mkdir(extractedDir);
  const archiveRoot = isWindowsX64
    ? `node-${version}-win-x64`
    : `node-${version}-darwin-arm64`;
  const nodeExecutable = isWindowsX64 ? "node.exe" : "node";
  await execFileAsync("tar", [
    isWindowsX64 ? "-xf" : "-xzf",
    archivePath,
    "--strip-components=1",
    "-C",
    extractedDir,
    `${archiveRoot}/${isWindowsX64 ? "" : "bin/"}${nodeExecutable}`,
    `${archiveRoot}/LICENSE`,
  ]);

  await mkdir(resourcesDir, { recursive: true });
  const extractedNode = isWindowsX64
    ? join(extractedDir, nodeExecutable)
    : join(extractedDir, "bin", nodeExecutable);
  await copyFile(extractedNode, join(resourcesDir, nodeExecutable));
  if (!isWindowsX64) await chmod(join(resourcesDir, nodeExecutable), 0o755);
  await copyFile(join(extractedDir, "LICENSE"), join(resourcesDir, "LICENSE"));
  const licensesDir = join(resourcesDir, "licenses");
  await mkdir(licensesDir, { recursive: true });
  await copyFile(join(root, "LICENSE"), join(licensesDir, "tasknboard.txt"));
  for (const dependency of ["zod", "react", "react-dom", "scheduler"]) {
    await copyFile(
      join(root, "node_modules", dependency, "LICENSE"),
      join(licensesDir, `${dependency}.txt`),
    );
  }

  await build({
    entryPoints: [serverEntry],
    outfile: join(resourcesDir, "server.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["node:*"],
    sourcemap: false,
  });

  await rm(join(resourcesDir, "dist"), { recursive: true, force: true });
  await cp(distDir, join(resourcesDir, "dist"), { recursive: true });

  console.log(`Prepared desktop resources in ${resourcesDir}`);
  console.log(`Verified ${archiveName} against official SHASUMS256.txt.`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
