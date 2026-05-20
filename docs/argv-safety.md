# Subprocess argv safety audit

Every secret-bearing subprocess invocation in nostr-station has been
audited against the question: "if `ps -ef` is readable by another
process / user on this machine, what can they see?"

The default SECURITY.md threat model excludes adversarial local users
from in-scope concerns. This doc exists so that:

1. Operators running nostr-station in shared environments (CI runners,
   multi-tenant containers, jump hosts) know exactly which secrets
   are exposed by command-line argument vs which go through stdin/env.
2. Future contributors have a tripwire — any new subprocess that
   passes a token, password, nsec, or API key as an argv element
   should be refactored or noted here.

## Convention

- Static argv (fixed strings, structured paths) — safe.
- User-supplied data in argv (paths, URLs, branch names) — safe if
  not secret-bearing. Use `execFile` / `execa` / `spawn` with array
  args (never `exec` with shell strings).
- **Secret data** (nsec, API key, session token, bunker secret,
  NIP-46 challenge, keychain password) in argv — NOT SAFE. Refactor
  to pass via stdin or environment variable, with a clear in-code
  rationale comment.

## Surveyed call sites

### Safe — no secrets in argv

| File:line | Command | Why safe |
|---|---|---|
| `src/lib/git-identity.ts:76, 108, 111, 133, 165, 168, 188, 195, 218, 221, 237` | `git config …` | User name/email or static config keys; not secrets. |
| `src/lib/git.ts` (multiple) | `git status / diff / log / push / pull / …` | Standard git verbs, paths come from validated project entries. |
| `src/lib/nostr-query.ts:242` | `nak req` | Filter args from API requests; no secret material. |
| `src/lib/nostr-query.ts:408` | `git ls-files` | Static argv. |
| `src/lib/nvpn-installer.ts:62, 95, 134, 163, 193` | `nvpn`, `tar`, `sudo` | Static argv. Tar `-C` target is a temp dir we own. |
| `src/lib/project-scaffold.ts:181, 206` | `git config`, `spawn(cmd, args, ...)` | Cmd is from the scaffold spec (allowlist), args from validated template config. |
| `src/lib/tools.ts` | Install runners | Cmd + args from the static `TOOLS` registry; user sees the literal command before confirming (see SECURITY.md). |
| `src/lib/keychain.ts:81, 89, 98` (Linux GNOME Keyring) | `secret-tool …` with `input: value` | Secret value passes via **stdin**, not argv. ✓ |
| `src/lib/promote.ts`, `src/lib/sync.ts`, `src/lib/auto-sync.ts` | Various git ops via `execFile` arrays | No secrets — git pushes are signed by ngit, the signing key lives in Amber off-machine. |
| `src/lib/terminal.ts` + `src/lib/routes/terminal.ts` | `node-pty.spawn(shell, args)` | Args are the resolved CLI key (e.g. `claude-code`) from a server-side allowlist — no token / nsec material. |

### Known issue — accepted with documented mitigation

| File:line | Command | Issue | Why accepted |
|---|---|---|---|
| `src/lib/keychain.ts:47-67` | `security add-generic-password -s nostr-station -a <key> -w <value>` (macOS) | The secret `<value>` is passed as an argv element. Visible to `ps -ef` while the spawn is in flight (typically < 50 ms). | `security` has no documented non-interactive stdin mode for password input. The standard macOS practice is `-w`. The window is small (single syscall lifetime) and the threat (concurrent shell access by an adversarial local user) is explicitly out of the SECURITY.md threat model. The Linux equivalent (`secret-tool store … --label … service … key …` with `{ input: value }`) DOES use stdin and is safe — the same pattern can't be applied on macOS without an FFI binding to Security.framework. Tracked as a follow-up. |

## Adding new subprocess calls

When a new subprocess invocation is added, check it against this list:

1. Are any of {nsec, AI API key, session token, bunker secret, NIP-46
   challenge, keychain password} flowing into the argv?

   - No → safe. (If user-supplied paths/URLs reach the argv, ensure
     `execFile`/`execa`/`spawn` array form is used — NEVER `exec` with
     a constructed shell string.)

   - Yes → refactor. Pass via `{ input: value }` (execa stdin) or via
     `{ env: { …, SECRET: value } }`. Environment is visible to the
     child but typically NOT to `ps`, and standard advice is "stdin >
     env > argv" for secret material.

2. Add an entry to the "Safe" or "Known issue" table above so future
   audits don't have to re-discover the rationale.

## Last reviewed

The catalog above corresponds to the source tree at the commit that
introduces this file. Re-run the audit grep periodically:

```bash
grep -rnE "execa\(|execFile\(|spawn\(|execSync\(|execFileSync\(" src/
```

and confirm each new hit against the convention above.
