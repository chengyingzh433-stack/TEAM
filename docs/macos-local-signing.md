# macOS local update identity

Use one persistent code-signing certificate for local Lancer builds. Configure its
40-character SHA-1 fingerprint in `LANCER_MAC_SIGNING_IDENTITY`, or in
`~/Library/Application Support/Lancer/local-signing.json` as `{"identity":"…"}`.
For an independent keychain, add an absolute `keychain` path to that JSON
(or set `LANCER_MAC_SIGNING_KEYCHAIN`). The runner passes it as `CSC_KEYCHAIN`
without changing the default keychain or importing other applications' keys.
The keychain must already be unlocked through the user's macOS interaction.
Passwords are never stored in this configuration.

The private key stays in Keychain; do not export it into this repository.
The packaging runner pins that identity and enables `forceCodeSigning`: a missing
certificate must fail, never silently fall back to ad-hoc signing.

`bash scripts/build-mac-lancer.sh --skip-install --dir --install` builds into a
unique directory and installs only after Lancer is quit normally. The installer
verifies signatures and bundle ID, rejects changes to the designated requirement,
stages before replacing, and retains the previous app for rollback. It does not
reset TCC, modify permission databases, strip quarantine, or kill applications.

The one-time transition from an already authorized ad-hoc build changes its
identity. Run `node apps/desktop/scripts/install-mac-app.mjs <candidate.app>
--migrate-signing` deliberately for that transition only; macOS may require the
same accessibility permission to be confirmed once. Subsequent updates must use
the same certificate and bundle identifier. Do not rotate the certificate merely
to fix a build failure. Certificate-backed signing alone does not establish that
TCC authorization survived: verify a real native operation after replacing one
build with another, without touching the permission settings between them.

This local scheme is not Apple notarization or a public distribution claim.
Public releases should use an appropriate Developer ID and notarization workflow.
Apple's identity model: https://developer.apple.com/library/archive/technotes/tn2206/

## TEAM explicit preview distribution

`pnpm --filter @lancer/desktop run package:mac:preview` deliberately builds an
Apple Silicon ad-hoc test DMG and ZIP, with `preview` in artifact filenames.
It bundles the Pi runtime and pinned search tools. This mode never replaces an
installed application or publishes automatically. It is not Developer ID signing
or notarization; recipients may encounter Gatekeeper. See
[TEAM macOS installation](team-macos-install.md).

The default runner still rejects missing persistent certificates. A failed signed
build does not fall back to preview. `install-mac-app.mjs` continues to reject an
ad-hoc identity and now targets `/Applications/TEAM.app`; old Lancer apps are not
removed or migrated automatically.
