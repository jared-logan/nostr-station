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
  'nvpn': '4.0.37',
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
  // grain: Go relay (https://github.com/0ceanSlim/grain), used by the
  // Communities feature. One binary per community, supervised by the
  // dashboard, bound to an nvpn tunnel IP — never installed for solo-
  // dev use. Per-target tarball; bump in lockstep with BINARY_SHA256.grain
  // below. Tied to an undocumented quirk of the upstream config: the
  // `server.port` field accepts `host:port` (passed straight to Go's
  // http.Server.Addr), which is how we honor the bind-IP security rule.
  // If a future GRAIN release stops accepting that format, the
  // supervisor's bind-address probe will catch the regression.
  'grain': '0.6.0',
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
    'aarch64-apple-darwin':       '3a6fef13fd1bb1637777f4fa8d31de9052bc3864029eca6048e30b47acca7feb',
    'aarch64-unknown-linux-musl': 'edcf98d68618f1badb4007fb64705b1db923d5278510768d68675b56d5736332',
    'x86_64-unknown-linux-musl':  '79d954664e7fee3d4ab841503f6a1b221b110a1af9c34db4b959fd6c19bac6de',
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
  // grain asset filename: grain-{os}-{arch}.tar.gz
  // os: darwin | linux ;  arch: amd64 | arm64
  // Digests pulled from
  // https://github.com/0ceanSlim/grain/releases/download/v0.6.0/checksums.txt
  grain: {
    'darwin-amd64': 'c89caf6ae3cc199c41f6ffff5fc3ecc637b7ed13941b356b14c7984bb35bb000',
    'darwin-arm64': 'b1a13e89be0f954c868923c297473a0cb7eb3776f6b6b39c8da053818c8610bb',
    'linux-amd64':  'e32b7e69df4b1ac659c776a9866a58d601e2240630016ddfad1e87b9f7677e92',
    'linux-arm64':  'cf89eae527899858d39ee09b48db7e78f096c869c6af7b955ec94f8b73693d50',
  },
};
