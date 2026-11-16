import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareAppImageTools } from "./appimage-tools.mjs";
import { withGithubDownloadRetry } from "./github-download-retry.mjs";
import { macSigningPolicy } from "./mac-signing-policy.mjs";
import { prepareMacTools } from "./prepare-mac-tools.mjs";
import { releaseHomepage } from "./release-homepage.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repoDir = path.resolve(desktopDir, "..", "..");
const toolsDir = path.join(repoDir, "tools");
const cacheRoot = path.join(repoDir, ".cache");

function createPackagingEnv() {
  // electron-builder wraps pnpm.cmd in a temporary .bat file. On Windows locales
  // that use a non-UTF-8 code page, paths under a non-ASCII %USERPROFILE% are
  // corrupted and pnpm list fails with "The system cannot find the path specified."
  // Prefer the ASCII repo-local shim first.
  const pathPrefix = [toolsDir, path.join(repoDir, "node_modules", ".bin")];
  const envPath = [...pathPrefix, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter);
  const electronBuilderCache =
    process.env.ELECTRON_BUILDER_CACHE ?? path.join(cacheRoot, "electron-builder");
  const localAppData = process.env.LOCALAPPDATA ?? path.join(cacheRoot, "localappdata");
  mkdirSync(electronBuilderCache, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...process.env,
    PATH: envPath,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    LOCALAPPDATA: localAppData,
    COREPACK_ENABLE_STRICT: "0",
  };
}

function spawnElectronBuilder(electronBuilderArgs, signingEnv = {}) {
  const pnpmBinary = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const result = spawnSync(pnpmBinary, ["exec", "electron-builder", ...electronBuilderArgs], {
    cwd: desktopDir,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...createPackagingEnv(), ...signingEnv },
    shell: process.platform === "win32",
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}\n${result.error?.message ?? ""}`;
  return {
    ok: result.status === 0 && !result.error,
    status: result.status ?? (result.signal ? 1 : 0),
    output,
    error: result.error,
  };
}

export async function runElectronBuilder(electronBuilderArgs) {
  if (electronBuilderArgs.includes("--mac-preview") && !electronBuilderArgs.includes("--mac"))
    throw new Error("--mac-preview requires --mac");
  const homepage = releaseHomepage(
    process.env,
    electronBuilderArgs.includes("--linux") && !electronBuilderArgs.includes("--dir"),
  );
  if (homepage)
    electronBuilderArgs = [...electronBuilderArgs, `-c.extraMetadata.homepage=${homepage}`];
  const signingEnv = {};
  if (electronBuilderArgs.includes("--linux") && !electronBuilderArgs.includes("--dir")) {
    // The pinned AppImage toolset exports an old libm before calling basename.
    // Newer GitHub runners then fail mksquashfs with GLIBC_2.43 not found.
    signingEnv.APPIMAGE_TOOLS_PATH = await prepareAppImageTools(cacheRoot);
  }
  if (process.platform === "darwin" && electronBuilderArgs.includes("--mac")) {
    const configPath = path.join(
      os.homedir(),
      "Library/Application Support/Lancer/local-signing.json",
    );
    const configured = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
    const policy = macSigningPolicy(electronBuilderArgs, process.env, configured);
    electronBuilderArgs = policy.args;
    Object.assign(signingEnv, policy.env);
    await prepareMacTools();
  }
  const result = await withGithubDownloadRetry(() =>
    spawnElectronBuilder(electronBuilderArgs, signingEnv),
  );
  if (result.error) {
    throw result.error;
  }
  return result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const electronBuilderArgs = process.argv.slice(2);
  if (electronBuilderArgs.length === 0) {
    throw new Error("Usage: run-electron-builder.mjs <electron-builder args...>");
  }
  process.exit(await runElectronBuilder(electronBuilderArgs));
}
