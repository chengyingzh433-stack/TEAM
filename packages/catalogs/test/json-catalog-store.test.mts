import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionCatalogEntry } from "../dist/index.js";
import { JsonCatalogStore } from "../dist/node/index.js";

const timestamp = "2026-07-27T00:00:00.000Z";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-catalog-store-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

await test("setting the same session file preserves committed catalog bytes", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const store = new JsonCatalogStore({ catalogFilePath });
    const ref = { workspaceId: "workspace", sessionId: "session" };
    const sessionFile = join(dir, "session.jsonl");
    await store.setSessionFile(ref, sessionFile);

    // Valid JSON with distinct formatting makes an unnecessary atomic rewrite observable
    // without sleeps, inode assumptions, or timestamp precision requirements.
    const committed = `${JSON.stringify(JSON.parse(await readFile(catalogFilePath, "utf8")), null, 4)}\n \t \t\n`;
    await writeFile(catalogFilePath, committed, "utf8");
    await store.setSessionFile(ref, sessionFile);

    assert.equal(await readFile(catalogFilePath, "utf8"), committed);
    assert.equal(await store.getSessionFile(ref), sessionFile);
    assert.equal(await new JsonCatalogStore({ catalogFilePath }).getSessionFile(ref), sessionFile);
  });
});

await test("setting a different session file persists the replacement mapping", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const store = new JsonCatalogStore({ catalogFilePath });
    const ref = { workspaceId: "workspace", sessionId: "session" };
    const firstFile = join(dir, "first.jsonl");
    const replacementFile = join(dir, "replacement.jsonl");
    await store.setSessionFile(ref, firstFile);
    const before = await readFile(catalogFilePath, "utf8");

    await store.setSessionFile(ref, replacementFile);

    assert.notEqual(await readFile(catalogFilePath, "utf8"), before);
    assert.equal(await store.getSessionFile(ref), replacementFile);
    assert.equal(
      await new JsonCatalogStore({ catalogFilePath }).getSessionFile(ref),
      replacementFile,
    );
  });
});

await test("same-path session file stores decide no-ops inside the shared mutation queue", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const first = new JsonCatalogStore({ catalogFilePath });
    const second = new JsonCatalogStore({ catalogFilePath });
    const ref = { workspaceId: "workspace", sessionId: "session" };
    const originalFile = join(dir, "original.jsonl");
    const replacementFile = join(dir, "replacement.jsonl");
    await first.setSessionFile(ref, originalFile);
    assert.equal(await second.getSessionFile(ref), originalFile);

    // The second store has the original cached value, but its later setter must
    // restore that value after the first store's already-enqueued replacement.
    await Promise.all([
      first.setSessionFile(ref, replacementFile),
      second.setSessionFile(ref, originalFile),
    ]);
    assert.equal(await first.getSessionFile(ref), originalFile);
    assert.equal(await second.getSessionFile(ref), originalFile);

    await Promise.all([
      second.setSessionFile(ref, replacementFile),
      first.setSessionFile(ref, replacementFile),
    ]);
    assert.equal(await first.getSessionFile(ref), replacementFile);
    assert.equal(await second.getSessionFile(ref), replacementFile);
    assert.equal(
      await new JsonCatalogStore({ catalogFilePath }).getSessionFile(ref),
      replacementFile,
    );
  });
});

await test("same-path stores serialize concurrent workspace, session, and worktree mutations", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const workspaceWriter = new JsonCatalogStore({ catalogFilePath });
    const sessionWriter = new JsonCatalogStore({ catalogFilePath });
    const worktreeWriter = new JsonCatalogStore({ catalogFilePath });
    await Promise.all([
      workspaceWriter.workspaces.listWorkspaces(),
      sessionWriter.sessions.listSessions(),
      worktreeWriter.worktrees.listWorktrees(),
    ]);

    const writes = Array.from({ length: 12 }, (_, index) => {
      const workspaceId = `workspace-${index}`;
      return Promise.all([
        workspaceWriter.workspaces.upsertWorkspace({
          workspaceId,
          path: join(dir, workspaceId),
          displayName: `Workspace ${index}`,
          lastOpenedAt: timestamp,
          sortOrder: index,
        }),
        sessionWriter.sessions.upsertSession({
          sessionRef: { workspaceId, sessionId: `session-${index}` },
          workspaceId,
          title: `Session ${index}`,
          updatedAt: timestamp,
          status: "idle",
        }),
        worktreeWriter.worktrees.upsertWorktree({
          worktreeId: join(dir, `worktree-${index}`),
          workspaceId,
          path: join(dir, `worktree-${index}`),
          displayName: `Worktree ${index}`,
          kind: "linked",
          status: "ready",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      ]);
    });
    await Promise.all(writes);

    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: unknown[];
      sessions: unknown[];
      worktrees: unknown[];
    };
    assert.equal(persisted.workspaces.length, 12);
    assert.equal(persisted.sessions.length, 12);
    assert.equal(persisted.worktrees.length, 12);

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.equal((await reopened.workspaces.listWorkspaces()).workspaces.length, 12);
    assert.equal((await reopened.sessions.listSessions()).sessions.length, 12);
    assert.equal((await reopened.worktrees.listWorktrees()).worktrees.length, 12);
  });
});

await test("new stores reload an externally replaced catalog and preserve it on mutation", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const firstStore = new JsonCatalogStore({ catalogFilePath });
    await firstStore.workspaces.upsertWorkspace({
      workspaceId: "stale-workspace",
      path: join(dir, "stale-workspace"),
      displayName: "Stale workspace",
      lastOpenedAt: timestamp,
      sortOrder: 0,
    });

    const replacementPath = `${catalogFilePath}.external-replacement`;
    await writeFile(
      replacementPath,
      `${JSON.stringify(
        {
          version: 2,
          workspaces: [
            {
              workspaceId: "repaired-workspace",
              path: join(dir, "repaired-workspace"),
              displayName: "Repaired workspace",
              lastOpenedAt: timestamp,
              sortOrder: 0,
            },
          ],
          sessions: [],
          worktrees: [],
          sessionFiles: {},
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await rename(replacementPath, catalogFilePath);

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual(
      (await reopened.workspaces.listWorkspaces()).workspaces.map((entry) => entry.workspaceId),
      ["repaired-workspace"],
    );

    await reopened.workspaces.upsertWorkspace({
      workspaceId: "new-workspace",
      path: join(dir, "new-workspace"),
      displayName: "New workspace",
      lastOpenedAt: timestamp,
      sortOrder: 1,
    });

    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: Array<{ workspaceId: string }>;
    };
    assert.deepEqual(persisted.workspaces.map((entry) => entry.workspaceId).sort(), [
      "new-workspace",
      "repaired-workspace",
    ]);
    assert.deepEqual(
      (await firstStore.workspaces.listWorkspaces()).workspaces
        .map((entry) => entry.workspaceId)
        .sort(),
      ["new-workspace", "repaired-workspace"],
    );
  });
});

await test("an interrupted temp write leaves the last committed catalog readable", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const catalog = new JsonCatalogStore({ catalogFilePath });
    await catalog.workspaces.upsertWorkspace({
      workspaceId: "workspace",
      path: join(dir, "workspace"),
      displayName: "Workspace",
      lastOpenedAt: timestamp,
      sortOrder: 0,
    });

    await writeFile(`${catalogFilePath}.interrupted.tmp`, '{"version":2,"workspaces":[', "utf8");

    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual(
      (await reopened.workspaces.listWorkspaces()).workspaces.map((entry) => entry.workspaceId),
      ["workspace"],
    );
    const persisted = JSON.parse(await readFile(catalogFilePath, "utf8")) as {
      workspaces: unknown[];
    };
    assert.equal(persisted.workspaces.length, 1);
  });
});

const validWorkspace = {
  workspaceId: "workspace",
  path: "/workspace",
  displayName: "Workspace",
  lastOpenedAt: timestamp,
  sortOrder: 0,
};
const validSession = {
  workspaceId: "workspace",
  sessionRef: { workspaceId: "workspace", sessionId: "session" },
  title: "Session",
  updatedAt: timestamp,
  status: "idle",
};
const validWorktree = {
  worktreeId: "worktree",
  workspaceId: "workspace",
  path: "/worktree",
  displayName: "Worktree",
  kind: "linked",
  status: "ready",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const validCatalog = {
  version: 2,
  workspaces: [validWorkspace],
  sessions: [validSession],
  worktrees: [validWorktree],
  sessionFiles: { "workspace:session": "/session.jsonl" },
};

await test("upserting an unchanged merged session preserves committed catalog bytes", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const store = new JsonCatalogStore({ catalogFilePath });
    await store.sessions.upsertSession(validSession);
    const metadata = {
      laneGroup: "routing-group",
      stage: "audit",
      progress: 0.5,
      startedAt: timestamp,
      finishedAt: null,
    };
    await store.sessions.updateControlMetadata(validSession.sessionRef, metadata);

    // The driver omits the separately owned runtime metadata. Its unchanged
    // upsert becomes the identical full row only after the existing merge.
    const committed = `${JSON.stringify(JSON.parse(await readFile(catalogFilePath, "utf8")), null, 4)}\n \t\t \t\n`;
    await writeFile(catalogFilePath, committed, "utf8");
    await store.sessions.upsertSession(validSession);

    assert.equal(await readFile(catalogFilePath, "utf8"), committed);
    assert.deepEqual(await store.sessions.getSession(validSession.sessionRef), {
      ...validSession,
      ...metadata,
    });
  });
});

await test("session upserts persist updatedAt, preview, and explicitly cleared metadata", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const store = new JsonCatalogStore({ catalogFilePath });
    let expected: SessionCatalogEntry = {
      ...validSession,
      status: "idle",
      previewSnippet: "Original preview",
      startedAt: timestamp,
      finishedAt: timestamp,
      stage: "analysis",
      progress: 0.5,
    };
    await store.sessions.upsertSession(expected);

    const patches: Partial<SessionCatalogEntry>[] = [
      { updatedAt: "2026-07-27T00:00:01.000Z" },
      { previewSnippet: "Changed preview" },
      { finishedAt: null, stage: null, progress: null },
    ];
    for (const patch of patches) {
      const before = await readFile(catalogFilePath, "utf8");
      expected = { ...expected, ...patch };
      await store.sessions.upsertSession(expected);
      assert.notEqual(await readFile(catalogFilePath, "utf8"), before);
      assert.deepEqual(
        await new JsonCatalogStore({ catalogFilePath }).sessions.getSession(expected.sessionRef),
        expected,
      );
    }
  });
});

await test("queued driver upserts retain another store's latest runtime metadata", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const first = new JsonCatalogStore({ catalogFilePath });
    const second = new JsonCatalogStore({ catalogFilePath });
    const initial: SessionCatalogEntry = {
      ...validSession,
      status: "idle",
      startedAt: timestamp,
      finishedAt: timestamp,
      stage: "analysis",
      progress: 0.5,
    };
    await first.sessions.upsertSession(initial);
    assert.deepEqual(await second.sessions.getSession(initial.sessionRef), initial);

    const driverRow: SessionCatalogEntry = {
      ...validSession,
      status: "idle",
      updatedAt: "2026-07-27T00:00:02.000Z",
      previewSnippet: "Latest driver preview",
    };
    await Promise.all([
      first.sessions.updateControlMetadata(initial.sessionRef, { stage: "audit", progress: 1 }),
      second.sessions.upsertSession(driverRow),
      first.sessions.updateControlMetadata(initial.sessionRef, { finishedAt: null }),
    ]);

    const expected = {
      ...driverRow,
      startedAt: timestamp,
      finishedAt: null,
      stage: "audit",
      progress: 1,
    };
    assert.deepEqual(await first.sessions.getSession(initial.sessionRef), expected);
    assert.deepEqual(await second.sessions.getSession(initial.sessionRef), expected);
    assert.deepEqual(
      await new JsonCatalogStore({ catalogFilePath }).sessions.getSession(initial.sessionRef),
      expected,
    );
  });
});

await test("invalid catalog data rejects reads and writes without dropping any saved records", async (t) => {
  const cases: Record<string, unknown> = {
    "future version": { ...validCatalog, version: 3 },
    "null document": null,
    "array document": [],
    "missing v2 collection": { ...validCatalog, sessions: undefined },
    "wrong collection shape": { ...validCatalog, workspaces: {} },
    "null workspace among valid records": { ...validCatalog, workspaces: [validWorkspace, null] },
    "workspace timestamp": {
      ...validCatalog,
      workspaces: [{ ...validWorkspace, lastOpenedAt: 12 }],
    },
    "workspace sort order": {
      ...validCatalog,
      workspaces: [{ ...validWorkspace, sortOrder: "0" }],
    },
    "workspace pinned": { ...validCatalog, workspaces: [{ ...validWorkspace, pinned: "yes" }] },
    "session reference": { ...validCatalog, sessions: [{ ...validSession, sessionRef: {} }] },
    "session workspace mismatch": {
      ...validCatalog,
      sessions: [{ ...validSession, workspaceId: "other" }],
    },
    "session status": { ...validCatalog, sessions: [{ ...validSession, status: "unknown" }] },
    "session optional field": {
      ...validCatalog,
      sessions: [{ ...validSession, archivedAt: false }],
    },
    "worktree kind": { ...validCatalog, worktrees: [{ ...validWorktree, kind: "unknown" }] },
    "worktree status": { ...validCatalog, worktrees: [{ ...validWorktree, status: "unknown" }] },
    "worktree optional field": {
      ...validCatalog,
      worktrees: [{ ...validWorktree, branchName: [] }],
    },
    "file map array": { ...validCatalog, sessionFiles: [] },
    "file map value": { ...validCatalog, sessionFiles: { "workspace:session": null } },
    "legacy malformed collection": { version: 1, sessions: null },
  };
  for (const [name, contents] of Object.entries(cases)) {
    await t.test(name, async () => {
      await withTempDir(async (dir) => {
        const catalogFilePath = join(dir, "catalogs.json");
        const original = `${JSON.stringify(contents, null, 2)}\n`;
        await writeFile(catalogFilePath, original);
        const store = new JsonCatalogStore({ catalogFilePath });
        const error = /(?:Invalid catalog file contents|Unsupported catalog file format)/;
        await assert.rejects(store.workspaces.listWorkspaces(), error);
        await assert.rejects(store.sessions.listSessions(), error);
        await assert.rejects(store.worktrees.listWorktrees(), error);
        await assert.rejects(store.workspaces.deleteWorkspace("workspace"), error);
        await assert.rejects(store.setSessionFile(validSession.sessionRef, "/new.jsonl"), error);
        assert.equal(await readFile(catalogFilePath, "utf8"), original);
      });
    });
  }
});

await test("legacy catalogs retain records and upgrade only when a mutation succeeds", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    const original = JSON.stringify({
      version: 1,
      workspaces: [validWorkspace],
      sessions: [validSession],
    });
    await writeFile(catalogFilePath, original);
    const store = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual((await store.sessions.listSessions()).sessions, [validSession]);
    assert.deepEqual((await store.worktrees.listWorktrees()).worktrees, []);
    assert.equal(await store.getSessionFile(validSession.sessionRef), undefined);
    assert.equal(await readFile(catalogFilePath, "utf8"), original);
    await store.setSessionFile(validSession.sessionRef, "/session.jsonl");
    const reopened = new JsonCatalogStore({ catalogFilePath });
    assert.deepEqual((await reopened.workspaces.listWorkspaces()).workspaces, [validWorkspace]);
    assert.deepEqual((await reopened.sessions.listSessions()).sessions, [validSession]);
    assert.equal(await reopened.getSessionFile(validSession.sessionRef), "/session.jsonl");
  });
});

await test("a failed load can be retried after the original catalog is repaired", async () => {
  await withTempDir(async (dir) => {
    const catalogFilePath = join(dir, "catalogs.json");
    await writeFile(catalogFilePath, JSON.stringify({ ...validCatalog, sessions: [null] }));
    const store = new JsonCatalogStore({ catalogFilePath });
    await assert.rejects(store.sessions.listSessions(), /Invalid catalog file contents/);
    await writeFile(catalogFilePath, JSON.stringify(validCatalog));
    assert.deepEqual((await store.sessions.listSessions()).sessions, [validSession]);
  });
});
