// Pinned versions for binaries we install directly.
//
// nvpn / nak / ngit each have a dedicated installer that downloads the
// upstream GitHub release asset, sha256-verifies it against the table
// below, and drops the binary on PATH. Everything else is opt-in via
// `nostr-station add` (npm -g / manual installer URL).
export const COMPONENT_VERSIONS: Partial<Record<string, string>> = {
  // nvpn: Rust binary tarball, fetched from
  // https://github.com/mmalmi/nostr-vpn releases. Bump in lockstep with
  // BINARY_SHA256.nvpn below.
  'nvpn': '0.3.12',
  // nak: Go binary, fetched from https://github.com/fiatjaf/nak releases.
  // The crates.io entry of the same name is unrelated — historically
  // this entry was a `cargo install nak` step that silently installed
  // the wrong tool. Bump in lockstep with BINARY_SHA256.nak below.
  'nak':  '0.19.7',
  // ngit: Rust binary tarball, fetched from
  // https://github.com/DanConwayDev/ngit-cli releases. Pre-fix the tools
  // registry tried `cargo install ngit`, which required Rust on the host
  // — install.sh deliberately doesn't ship Rust, so the Status panel
  // Install button always failed at the prereq check. Bump in lockstep
  // with BINARY_SHA256.ngit below.
  'ngit': '2.4.3',
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
  // nak asset filename: nak-v{version}-{os}-{arch}
  // os: darwin | linux ;  arch: amd64 | arm64
  nak: {
    'darwin-amd64': 'e3476590abc55fe426377614c5875a8dcbb0d7ae756157d4df87caccf9693ac5',
    'darwin-arm64': 'a15321ef0442a3112bbf26c512c1daa58458be3678b9bb552dc69f2b2e14bc2d',
    'linux-amd64':  'd98c575e2a070d8aad8630b173a22a425484fe1a1c7b94bf71a46b0e7c2cf591',
    'linux-arm64':  '6882b4ebd0adb2e606680a96db0723239475cf6e570e6f3ff3264059b9fc9f03',
  },
  nvpn: {
    'aarch64-apple-darwin':       '7fd31fd1cf2b23ef4eb1550dd0580c6dbe00ddc5712cdc5210881860a2260582',
    'aarch64-unknown-linux-musl': 'c5976952a1ea31d1f8a06697cc034725ece49637378f30a74b8b5e54956d3cbd',
    'x86_64-unknown-linux-musl':  '2e54cc12208bff537b069e93d1aeffc4e80d22573f23d29157eff5e1c0de90fb',
    // x86_64-apple-darwin: upstream does not publish this asset.
  },
  // ngit asset filename: ngit-v{version}-{target}.tar.gz
  // Upstream publishes a single universal-apple-darwin tarball that
  // works on both Intel + Apple Silicon, so one digest covers both Mac
  // arches. linux uses gnu (glibc ≥ 2.17, ~CentOS 7 / 2014 — covers
  // every modern distro); musl variant exists upstream but isn't pinned
  // here until we hear demand from Alpine users.
  ngit: {
    'universal-apple-darwin':         '63af6f753ab9ecbe76d1d7d99050823a84237b3709bd814194436b2a34beafe2',
    'x86_64-unknown-linux-gnu.2.17':  '747d7de6c1c4f26818606c6098993e8789271051201b7e3b76baff6fa4b7753b',
    'aarch64-unknown-linux-gnu.2.17': '182c0fe41b57ce995dfe6aa60ea379b7024ef32265675fc88384337970c9573a',
  },
};
