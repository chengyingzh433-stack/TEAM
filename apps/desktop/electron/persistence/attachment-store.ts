import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readJsonWithBackup, writeFileAtomicQueued } from "./atomic-file-write";
import type { ComposerAttachment } from "../../contracts/desktop-state";

export class AttachmentStore {
  private readonly rootDir: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "attachments");
  }

  async read(sessionKey: string): Promise<ComposerAttachment[] | undefined> {
    let result = await readJsonWithBackup(this.filePath(sessionKey));
    const legacy = this.legacyPath(sessionKey);
    if (
      result.value === undefined &&
      !result.corrupted &&
      legacy &&
      legacy !== this.filePath(sessionKey)
    )
      result = await readJsonWithBackup(legacy);
    if (result.corrupted && !result.recovered) {
      throw new Error(
        `Invalid saved attachments at ${this.filePath(sessionKey)}; original data was retained.`,
      );
    }
    if (result.corrupted) {
      console.error(
        `[attachment-store] corrupt entry for "${sessionKey}" in ${this.rootDir}` +
          (result.recovered ? " — recovered from backup" : " — no usable backup"),
      );
    }
    return result.value === undefined ? undefined : this.decodeSaved(sessionKey, result.value);
  }

  async write(sessionKey: string, data: readonly ComposerAttachment[]): Promise<void> {
    decodeAttachments(data);
    if (this.hashed(sessionKey)) await this.read(sessionKey);
    await writeFileAtomicQueued(
      this.filePath(sessionKey),
      `${JSON.stringify(this.hashed(sessionKey) ? { version: 1, sessionKey, attachments: data } : data, null, 2)}\n`,
      (value) => this.decodeSaved(sessionKey, value),
    );
  }

  async listKeys(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDir);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    }

    const keys: string[] = [];
    for (const name of entries) {
      if (!name.endsWith(".json")) {
        continue;
      }
      try {
        if (/^sha256-[a-f0-9]{64}\.json$/.test(name)) {
          const saved = await readJsonWithBackup(join(this.rootDir, name));
          const record = saved.value as { sessionKey?: unknown } | undefined;
          if (
            typeof record?.sessionKey !== "string" ||
            this.filePath(record.sessionKey) !== join(this.rootDir, name)
          )
            throw new Error("Invalid attachment key record; original file retained.");
          this.decodeSaved(record.sessionKey, saved.value);
          keys.push(record.sessionKey);
        } else keys.push(decodeURIComponent(name.slice(0, -".json".length)));
      } catch (error) {
        // A single malformed filename must not abort the whole listing; that
        // would silently disable attachment pruning for every key.
        console.error(
          `[attachment-store] skipping malformed filename "${name}" in ${this.rootDir}`,
          error,
        );
      }
    }
    return [...new Set(keys)];
  }

  async remove(sessionKey: string): Promise<void> {
    const paths = [
      ...new Set(
        [this.filePath(sessionKey), this.legacyPath(sessionKey)].filter((p): p is string => !!p),
      ),
    ];
    // Never prune an entry whose contents we cannot understand.
    for (const path of paths) {
      const saved = await readJsonWithBackup(path);
      if (saved.corrupted) {
        throw new Error(
          `Cannot prune corrupt saved attachments at ${path}; original data was retained.`,
        );
      }
      if (saved.value !== undefined) this.decodeSaved(sessionKey, saved.value);
    }
    for (const path of paths) {
      await this.unlinkIfPresent(path);
      await this.unlinkIfPresent(`${path}.bak`);
    }
  }

  private async unlinkIfPresent(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!(
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }

  private filePath(sessionKey: string): string {
    return this.hashed(sessionKey)
      ? join(this.rootDir, `sha256-${createHash("sha256").update(sessionKey).digest("hex")}.json`)
      : join(this.rootDir, `${encodeURIComponent(sessionKey)}.json`);
  }
  private hashed(sessionKey: string): boolean {
    return encodeURIComponent(sessionKey).length > 160;
  }
  private legacyPath(sessionKey: string): string | undefined {
    const name = `${encodeURIComponent(sessionKey)}.json`;
    // An overlong filename could never have been stored. Do not issue an invalid lookup.
    return name.length <= 255 ? join(this.rootDir, name) : undefined;
  }
  private decodeSaved(sessionKey: string, value: unknown): ComposerAttachment[] {
    if (Array.isArray(value)) return decodeAttachments(value);
    const record = value as { version?: unknown; sessionKey?: unknown; attachments?: unknown };
    if (
      !this.hashed(sessionKey) ||
      !record ||
      record.version !== 1 ||
      record.sessionKey !== sessionKey
    )
      throw new Error("Invalid saved attachment key; original data was retained.");
    return decodeAttachments(record.attachments);
  }
}

export function decodeAttachments(value: unknown): ComposerAttachment[] {
  if (!Array.isArray(value))
    throw new Error("Invalid saved attachments: expected an array; original data was retained.");
  return value.map((entry: unknown, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error(`Invalid saved attachment at index ${index}.`);
    const item = entry as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimeType !== "string"
    )
      throw new Error(`Invalid saved attachment metadata at index ${index}.`);
    const allowedKeys =
      item.kind === "file"
        ? ["id", "kind", "name", "mimeType", "fsPath", "sizeBytes"]
        : ["id", "kind", "name", "mimeType", "data"];
    if (Object.keys(item).some((key) => !allowedKeys.includes(key)))
      throw new Error(
        `Invalid saved attachment at index ${index}: unsupported field; original data was retained.`,
      );
    const base = { id: item.id, name: item.name, mimeType: item.mimeType };
    if ((item.kind === "image" || item.kind === undefined) && typeof item.data === "string")
      return { ...base, kind: "image", data: item.data };
    if (
      item.kind === "file" &&
      typeof item.fsPath === "string" &&
      (item.sizeBytes === undefined ||
        (typeof item.sizeBytes === "number" &&
          Number.isFinite(item.sizeBytes) &&
          item.sizeBytes >= 0))
    )
      return {
        ...base,
        kind: "file",
        fsPath: item.fsPath,
        ...(typeof item.sizeBytes === "number" ? { sizeBytes: item.sizeBytes } : {}),
      };
    throw new Error(
      `Invalid saved attachment payload at index ${index}; original data was retained.`,
    );
  });
}
