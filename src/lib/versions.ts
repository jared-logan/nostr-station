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
};

