import assert from "node:assert/strict";
import test from "node:test";
import { macSigningPolicy } from "./mac-signing-policy.mjs";

test("normal macOS updates still fail without a persistent identity", () => {
  assert.throws(() => macSigningPolicy(["--mac"], {}), /Refusing an implicit/);
  const identity = "a".repeat(40);
  const policy = macSigningPolicy(["--mac"], { LANCER_MAC_SIGNING_IDENTITY: identity });
  assert.ok(policy.args.includes(`-c.mac.identity=${identity}`));
  assert.ok(policy.args.includes("-c.forceCodeSigning=true"));
});

test("explicit preview is labeled, never published automatically, and cannot replace an app", () => {
  const args = ["--mac", "--mac-preview", "--publish", "never"];
  const policy = macSigningPolicy(args, {});
  assert.ok(policy.args.includes("-c.mac.identity=-"));
  assert.ok(
    policy.args.includes("-c.artifactName=${productName}-${version}-${arch}-preview.${ext}"),
  );
  assert.ok(!policy.args.includes("--mac-preview"));
  for (const bad of [
    ["--mac", "--mac-preview"],
    ["--win", "--mac-preview", "--publish", "never"],
    [...args, "--install"],
    [...args, "--x64"],
    [...args, "--universal"],
    [...args, "--", "-c.mac.identity=null"],
    [...args, "-c.mac.notarize=true"],
    [...args, "--publish=always"],
    [...args, "--publish", "always"],
  ])
    assert.throws(() => macSigningPolicy(bad, {}));
});
