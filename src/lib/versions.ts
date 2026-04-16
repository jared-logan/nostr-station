// Pinned versions for cargo-installable components.
// Values reflect the last validated install on macOS aarch64.
// Update when a new version has been tested end-to-end before bumping.
// Used by install.ts (first install) and Update/UpdateWizard (version drift detection).
//
// NOTE: nak is intentionally absent from this map. It is a Go binary, not a
// Rust crate — there is no `nak` on crates.io. We install it from fiatjaf's
// GitHub Releases via installNak() in install.ts, which currently tracks the
// latest release tag. If we want to pin nak, add a parallel mechanism there.
// See: https://github.com/fiatjaf/nak
export const COMPONENT_VERSIONS: Partial<Record<string, string>> = {
  'nostr-rs-relay': '0.8.12',
  'ngit':           '2.2.3',
  // node-pty is an npm package, but ships no prebuilts upstream and requires
  // a C++ toolchain to compile. We build prebuilts per-arch in CI (N-API so
  // one binary covers all Node >=22 ABIs) and host them on the nostr-station
  // GitHub releases. See .github/workflows/release-node-pty-prebuilts.yml
  // and installNodePtyPrebuilt() in install.ts.
  'node-pty':       '1.1.0',
};

