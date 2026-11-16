import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { extractAll } from "@electron/asar";

// Dependency verification only: never opens the GUI or submits a model request.
if (process.platform !== "darwin" || process.argv.length !== 4)
  throw new Error("Usage: node verify-mac-preview.mjs TEAM.app NEW_EVIDENCE_DIRECTORY");
const app = path.resolve(process.argv[2]);
const evidence = path.resolve(process.argv[3]);
await mkdir(evidence, { recursive: false });
const resources = path.join(app, "Contents/Resources");
const executable = path.join(app, "Contents/MacOS/TEAM");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const plist = JSON.parse(
  execFileSync(
    "/usr/bin/plutil",
    ["-convert", "json", "-o", "-", path.join(app, "Contents/Info.plist")],
    { encoding: "utf8" },
  ),
);
assert.equal(plist.CFBundleIdentifier, "com.lancer.desktop");
assert.equal(plist.CFBundleExecutable, "TEAM");
assert.equal(plist.LSMinimumSystemVersion, "13.0");
const extracted = path.join(evidence, "extracted");
extractAll(path.join(resources, "app.asar"), extracted);
const tools = JSON.parse(await readFile(path.join(resources, "tools/manifest.json"), "utf8"));
for (const tool of tools) {
  const binary = await readFile(path.join(resources, "tools/bin", tool.binary));
  // Signing may change a Mach-O binary's bytes. The packaged archive provenance
  // remains pinned; require a valid signature as well as its declared version.
  execFileSync("/usr/bin/codesign", [
    "--verify",
    "--strict",
    path.join(resources, "tools/bin", tool.binary),
  ]);
  const version = execFileSync(path.join(resources, "tools/bin", tool.binary), ["--version"], {
    encoding: "utf8",
  });
  assert.ok(version.includes(tool.version));
  tool.packagedSha256 = createHash("sha256").update(binary).digest("hex");
  for (const license of tool.licenses)
    assert.ok(
      (await readFile(path.join(resources, "tools/licenses", tool.binary, license))).length > 0,
    );
}
const home = path.join(evidence, "empty-home");
await mkdir(home);
const probe = path.join(extracted, "package-runtime-probe.mjs");
await writeFile(
  probe,
  `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getToolPath } from './node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
assert.equal(typeof pty.spawn, 'function');
assert.equal(typeof require('@napi-rs/canvas').createCanvas, 'function');
await import('./node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js');
await import('./node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js');
await import('./node_modules/@earendil-works/pi-ai/dist/api/google-generative-ai.js');
await import('./node_modules/@earendil-works/pi-ai/dist/bedrock-provider.js');
const runtime = await ModelRuntime.create({authPath: process.env.PI_CODING_AGENT_DIR + '/auth.json', modelsPath: null, refreshOnCreate: false});
assert.ok(runtime.getModels().length > 0);
assert.equal(getToolPath('rg'), 'rg');
assert.equal(getToolPath('fd'), 'fd');
console.log(JSON.stringify({electron:process.versions.electron,node:process.versions.node,arch:process.arch,models:runtime.getModels().length,nativePty:true,bundledSearchTools:true,modelRequests:0}));
`,
);
const output = execFileSync(executable, [probe], {
  cwd: home,
  env: {
    HOME: home,
    TMPDIR: home,
    PATH: `${path.join(resources, "tools/bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
    ELECTRON_RUN_AS_NODE: "1",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
  },
  encoding: "utf8",
  timeout: 60_000,
});
await writeFile(path.join(evidence, "runtime-probe.log"), output);
const report = {
  app,
  version: plist.CFBundleShortVersionString,
  minimumMacOS: plist.LSMinimumSystemVersion,
  runtime: JSON.parse(output.trim()),
  tools,
  guiTested: false,
  realModelTested: false,
  notarized: false,
};
await writeFile(path.join(evidence, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
