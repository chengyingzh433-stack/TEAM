import path from "node:path";
import { existsSync } from "node:fs";

// A preview is a deliberate distribution mode, never a fallback from failed signing.
export function macSigningPolicy(args, env, configured = {}) {
  if (args.includes("--"))
    throw new Error("Pass builder options directly, without a -- separator.");
  if (args.includes("--x64") || args.includes("--universal"))
    throw new Error("This macOS bundle currently supports arm64 only.");
  const preview = args.includes("--mac-preview");
  if (preview) {
    if (!args.includes("--mac") || args.includes("--win") || args.includes("--linux"))
      throw new Error("Preview signing is only supported for macOS.");
    const publish = args.indexOf("--publish");
    if (
      publish < 0 ||
      args.filter((arg) => arg === "--publish").length !== 1 ||
      args[publish + 1] !== "never" ||
      args.includes("--install")
    )
      throw new Error("Preview must use --publish never and cannot install over an existing app.");
    if (
      args.some((arg) =>
        /(?:identity|forceCodeSigning|notarize|hardenedRuntime|artifactName|publish=)/.test(arg),
      )
    )
      throw new Error("Preview signing and artifact labeling cannot be overridden.");
    return {
      args: [
        ...args.filter((arg) => arg !== "--mac-preview"),
        "-c.mac.identity=-",
        "-c.forceCodeSigning=false",
        "-c.mac.hardenedRuntime=false",
        "-c.mac.notarize=false",
        "-c.artifactName=${productName}-${version}-${arch}-preview.${ext}",
      ],
      env: {
        CSC_IDENTITY_AUTO_DISCOVERY: "false",
        CSC_LINK: undefined,
        CSC_KEY_PASSWORD: undefined,
      },
    };
  }
  const identity = env.LANCER_MAC_SIGNING_IDENTITY ?? configured.identity;
  if (!identity || !/^[A-Fa-f0-9]{40}$/.test(identity))
    throw new Error(
      "Configure a persistent certificate SHA-1. Refusing an implicit ad-hoc macOS update; use the explicit --mac-preview distribution mode for test packages.",
    );
  const keychain = env.LANCER_MAC_SIGNING_KEYCHAIN ?? configured.keychain;
  if (
    keychain !== undefined &&
    (typeof keychain !== "string" || !path.isAbsolute(keychain) || !existsSync(keychain))
  )
    throw new Error("Configured signing keychain must be an existing absolute path.");
  return {
    args: [...args, `-c.mac.identity=${identity}`, "-c.forceCodeSigning=true"],
    env: keychain ? { CSC_KEYCHAIN: keychain } : {},
  };
}
