// Pinned versions for cargo-installable components.
// Values reflect the last validated install on macOS aarch64.
// Update when a new version has been tested end-to-end before bumping.
// Used by install.ts (first install) and Update/UpdateWizard (version drift detection).
//
// `nak` and `nvpn` ship as platform binaries from upstream's GitHub Releases,
// not crates.io — but their version pins live alongside the cargo crates so
// UpdateWizard can drift-check uniformly. Per-asset SHA256 sums for those
// binaries live in BINARY_SHA256 below; bump both fields in lockstep.
export const COMPONENT_VERSIONS: Partial<Record<string, string>> = {
  'nostr-rs-relay': '0.8.12',
  'ngit':           '2.2.3',
  // nak: Go binary, fetched from https://github.com/fiatjaf/nak releases.
  'nak':            '0.19.7',
  // nvpn: Rust binary tarball, fetched from https://github.com/mmalmi/nostr-vpn releases.
  'nvpn':           '0.3.12',
  // node-pty is an npm package, but ships no prebuilts upstream and requires
  // a C++ toolchain to compile. We build prebuilts per-arch in CI (N-API so
  // one binary covers all Node >=22 ABIs) and host them on the nostr-station
  // GitHub releases. See .github/workflows/release-node-pty-prebuilts.yml
  // and installNodePtyPrebuilt() in install.ts.
  'node-pty':       '1.1.0',
};

// Per-target SHA256 hex digests for binaries we download directly from
// upstream GitHub Releases. Keyed by binary name → target → digest.
// Hard-failing on mismatch is the contract — installNak / installNostrVpn
// must NOT silently fall back to an unverified copy. To rotate after a
// version bump, fetch the matching release JSON and copy each
// `digest: "sha256:<hex>"` from the asset metadata:
//
//   curl -fsSL https://api.github.com/repos/fiatjaf/nak/releases/tags/v<ver>
//   curl -fsSL https://api.github.com/repos/mmalmi/nostr-vpn/releases/tags/v<ver>
//
// Targets we don't list (e.g. macOS x86_64 for nvpn — not published upstream)
// surface as a clear "no checksum pinned for <target>" error rather than a
// silent skip; the caller refuses the install instead of running an unverified
// binary.
export const BINARY_SHA256: Record<string, Record<string, string>> = {
  // nak asset filename: nak-v{version}-{os}-{arch}
  // os: darwin | linux ;  arch: amd64 | arm64
  nak: {
    'darwin-amd64': 'e3476590abc55fe426377614c5875a8dcbb0d7ae756157d4df87caccf9693ac5',
    'darwin-arm64': 'a15321ef0442a3112bbf26c512c1daa58458be3678b9bb552dc69f2b2e14bc2d',
    'linux-amd64':  'd98c575e2a070d8aad8630b173a22a425484fe1a1c7b94bf71a46b0e7c2cf591',
    'linux-arm64':  '6882b4ebd0adb2e606680a96db0723239475cf6e570e6f3ff3264059b9fc9f03',
  },
  // nvpn asset filename: nvpn-{rust-target}.tar.gz (no version-prefixed
  // variant — the unversioned name redirects to latest tarball when fetched
  // from /releases/latest/download/, which we no longer use; we fetch the
  // versioned tag explicitly).
  nvpn: {
    'aarch64-apple-darwin':       '7fd31fd1cf2b23ef4eb1550dd0580c6dbe00ddc5712cdc5210881860a2260582',
    'aarch64-unknown-linux-musl': 'c5976952a1ea31d1f8a06697cc034725ece49637378f30a74b8b5e54956d3cbd',
    'x86_64-unknown-linux-musl':  '2e54cc12208bff537b069e93d1aeffc4e80d22573f23d29157eff5e1c0de90fb',
    // x86_64-apple-darwin: upstream does not publish this asset.
  },
};
