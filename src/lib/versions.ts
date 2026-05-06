// Pinned versions for binaries we install directly.
//
// Currently only nvpn — every other supported binary is opt-in via
// `nostr-station add` (cargo install / npm -g / manual installer URL),
// where the binary's own toolchain pins the version. The legacy entries
// for nostr-rs-relay / ngit / nak / node-pty had no live consumers in
// src/ once the host-install flow was deleted; they were retired
// alongside the rest of the cleanup.
export const COMPONENT_VERSIONS: Partial<Record<string, string>> = {
  // nvpn: Rust binary tarball, fetched from
  // https://github.com/mmalmi/nostr-vpn releases. Bump in lockstep with
  // BINARY_SHA256.nvpn below.
  'nvpn': '0.3.12',
};

// Per-target SHA256 hex digests for binaries we download directly from
// upstream GitHub Releases. Hard-failing on mismatch is the contract —
// installNostrVpn must NOT silently fall back to an unverified copy.
// To rotate after a version bump, fetch the matching release JSON and
// copy each `digest: "sha256:<hex>"` from the asset metadata:
//
//   curl -fsSL https://api.github.com/repos/mmalmi/nostr-vpn/releases/tags/v<ver>
//
// Targets we don't list (e.g. macOS x86_64 — not published upstream)
// surface as a clear "no checksum pinned for <target>" error rather than
// a silent skip; the caller refuses the install instead of running an
// unverified binary.
export const BINARY_SHA256: Record<string, Record<string, string>> = {
  nvpn: {
    'aarch64-apple-darwin':       '7fd31fd1cf2b23ef4eb1550dd0580c6dbe00ddc5712cdc5210881860a2260582',
    'aarch64-unknown-linux-musl': 'c5976952a1ea31d1f8a06697cc034725ece49637378f30a74b8b5e54956d3cbd',
    'x86_64-unknown-linux-musl':  '2e54cc12208bff537b069e93d1aeffc4e80d22573f23d29157eff5e1c0de90fb',
    // x86_64-apple-darwin: upstream does not publish this asset.
  },
};
