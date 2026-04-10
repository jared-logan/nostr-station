# Contributing to nostr-station

## Getting started

```bash
git clone https://github.com/jared-logan/nostr-station
cd nostr-station
npm install
npm run build
node dist/cli.js onboard    # run the wizard locally
```

Or use `tsx` for faster iteration without a rebuild step:

```bash
npm run dev -- onboard      # tsx src/cli.tsx onboard
```

## Project structure

```
src/
  cli.tsx                   Entry point — command dispatch
  commands/                 One file per top-level command
  lib/
    detect.ts               OS/arch/service detection
    install.ts              Package installation functions
    services.ts             Config file templates, NOSTR_STATION.md builder
    keychain.ts             OS keychain abstraction
    relay-config.ts         TOML read/write for relay config
    versions.ts             Pinned versions for Rust components
    completion.ts           Shell tab-completion scripts
  onboard/
    index.tsx               Wizard orchestrator (5 phases)
    components/             Reusable Ink UI components
    phases/                 Detect, Config, Install, Services, Verify
```

## Code style

- TypeScript strict mode
- React Ink for all TUI rendering — no raw `process.stdout.write` in UI paths
- Use `execa` with array args for all shell calls — never string concatenation
- No secrets in code or generated files — all keys go through `src/lib/keychain.ts`

## Security model — must not be broken

The core security invariant: **nsec never touches this machine**.

- Signing is always via Amber NIP-46 (ngit push, nsite publish)
- The watchdog keypair is the only nsec stored locally, and it goes into the OS keychain — never written to disk in plaintext
- AI provider API keys go into the OS keychain; `~/.claude_env` is a loader script, not a secret store
- All `execa` calls use array args to prevent shell injection

Contributions that compromise this model will not be merged.

## Submitting changes

1. Fork the repo and create a feature branch
2. Make your changes, `npm run build` to verify TypeScript compiles
3. Open a pull request — describe what you changed and why
4. Reference any related issues: [github.com/jared-logan/nostr-station/issues](https://github.com/jared-logan/nostr-station/issues)

## Bug reports

Use the [bug report template](https://github.com/jared-logan/nostr-station/issues/new?template=bug_report.md).
Include `nostr-station version`, OS/arch, and `nostr-station doctor` output.

See [CHANGELOG.md](CHANGELOG.md) for version history.
