// Pinned versions for cargo-installable components.
// Values reflect the last validated install on macOS aarch64.
// Update when a new version has been tested end-to-end before bumping.
// Used by install.ts (first install) and Update/UpdateWizard (version drift detection).
//
// NOTE: nak is intentionally not pinned here. On macOS it is typically
// installed via Homebrew (brew install nak), not cargo. The cargo install
// path for nak needs separate validation before a version pin is added.
// See: https://github.com/fiatjaf/nak
export const COMPONENT_VERSIONS: Partial<Record<string, string>> = {
  'nostr-rs-relay': '0.8.12',
  'ngit':           '2.2.3',
};

