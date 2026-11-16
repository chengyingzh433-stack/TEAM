import assert from "node:assert/strict";
import test from "node:test";
import { isTeamPublicSource, teamPublicSourceBytes } from "./export-source.mjs";

test("TEAM exports source and current icon but excludes private history, recordings and runtime data", () => {
  for (const file of [
    "README.md",
    "apps/desktop/resources/icon.png",
    "apps/desktop/resources/brand/team-icon.svg",
    "docs/team-install.md",
    "apps/desktop/contracts/research-discussion.ts",
  ])
    assert.equal(isTeamPublicSource(file), true, file);
  for (const file of [
    "docs/education-research-group-fusion-progress.md",
    "docs/education-research-group-next-handoff.md",
    "video/public/captures/debug-pre-slash.png",
    "apps/website/public/media/hero.mp4",
    "docs/branding/lancer-readme-banner.png",
    "apps/desktop/resources/brand/lancer-icon-source.jpg",
    ".pi/agent/auth.json",
    "deployment/backups/history.json",
    "apps/desktop/out/main/main.js",
  ])
    assert.equal(isTeamPublicSource(file), false, file);
});

test("TEAM export removes maintainer paths and redirects only documentation links", () => {
  const input = Buffer.from("/Users/example/project docs/education-research-group-next-handoff.md");
  assert.equal(
    teamPublicSourceBytes("README.md", input).toString(),
    "/Users/example/project docs/team-release.md",
  );
  assert.equal(
    teamPublicSourceBytes("scripts/export.test.mjs", input).toString(),
    "/Users/example/project docs/education-research-group-next-handoff.md",
  );
  const binary = Buffer.from([0xff, 0xfe, 0x00]);
  assert.deepEqual(teamPublicSourceBytes("icon.png", binary), binary);
});
