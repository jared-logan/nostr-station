// src/lib/tty.ts
//
// Helpers for guarding Ink-based commands against non-interactive stdin.
//
// The root problem: ink-select-input / ink-text-input / useInput all call
// stdin.setRawMode(true) on mount, which hard-throws "Raw mode is not
// supported" on non-TTY stdin (CI with `< /dev/null`, piped input, etc.).
// Once Ink throws during commit, it rewrites the screen with its error
// overlay, which clobbers any step output the user was about to see —
// so the original failure reason disappears.
//
// Prefer dispatcher-level gates (in cli.tsx) over inline component checks:
// failing fast BEFORE render() means we never mount Ink at all, so there's
// no screen rewrite and the error message survives in stderr.
//
// For commands that are sometimes interactive (e.g. seed only prompts when
// the relay has events), use the `canPrompt` pattern inline and auto-abort
// or auto-continue with a clear stderr message — see Install.tsx for the
// canonical example.

/**
 * Exits the process with a clear error if stdin is not a TTY.
 *
 * Call this BEFORE `render()` in cli.tsx for commands that unconditionally
 * require interactive input. Do not call from inside a component — by then
 * Ink is already mounted and the error overlay will eat your message.
 *
 * @param command - The command label for the error message, e.g. "push"
 * @param hint - Optional extra hint (e.g. "Pass --yes to skip confirmation")
 */
export function requireInteractive(command: string, hint?: string): void {
  if (process.stdin.isTTY) return;

  process.stderr.write(
    `\nnostr-station ${command}: interactive terminal required.\n`
    + `  This command prompts for input and can't run with piped/redirected stdin.\n`
    + (hint ? `  ${hint}\n` : '')
    + `  Run from a real terminal (not under \`< /dev/null\`, \`yes |\`, or similar).\n\n`,
  );
  process.exit(1);
}
