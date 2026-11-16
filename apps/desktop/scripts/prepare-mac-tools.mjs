import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareMacTools() {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    throw new Error("Bundled macOS tools currently require Apple Silicon.");
  const tools = JSON.parse(
    await readFile(path.join(desktop, "scripts/mac-bundled-tools.json"), "utf8"),
  );
  const cache =
    process.env.TEAM_TOOLS_CACHE ?? path.resolve(desktop, "../../.cache/team-macos-tools");
  const output = path.join(desktop, "build/packaged-tools/mac-arm64");
  await mkdir(cache, { recursive: true });
  await mkdir(path.join(output, "bin"), { recursive: true });
  const manifest = [];
  for (const tool of tools) {
    const archive = path.join(cache, path.basename(new URL(tool.url).pathname));
    let data;
    try {
      data = await readFile(archive);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const response = await fetch(tool.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Download failed: ${tool.binary} HTTP ${response.status}`);
      data = Buffer.from(await response.arrayBuffer());
      await writeFile(archive, data, { flag: "wx" });
    }
    if (createHash("sha256").update(data).digest("hex") !== tool.sha256)
      throw new Error(`Bundled ${tool.binary} archive checksum mismatch; retained ${archive}`);
    // Extract only pinned regular-file payloads, never archive paths into the app tree.
    const extract = (name) =>
      execFileSync("/usr/bin/tar", ["-xOf", archive, `${tool.directory}/${name}`], {
        maxBuffer: 32 * 1024 * 1024,
      });
    const binary = extract(tool.binary);
    await writeFile(path.join(output, "bin", tool.binary), binary, { mode: 0o755 });
    const licenseDir = path.join(output, "licenses", tool.binary);
    await mkdir(licenseDir, { recursive: true });
    for (const license of tool.licenses)
      await writeFile(path.join(licenseDir, license), extract(license));
    manifest.push({ ...tool, binarySha256: createHash("sha256").update(binary).digest("hex") });
  }
  await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Prepared pinned macOS tools and licenses: ${output}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await prepareMacTools();
