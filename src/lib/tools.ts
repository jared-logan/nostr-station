/**
 * Optional-tool registry for `nostr-station add <tool>`.
 *
 * Per the user-journey spec ("Optional means post-onboard"), tools that
 * aren't on the happy path live behind one explicit verb. The wizard
 * never asks about them, the dashboard never installs them silently —
 * the user opts in when they need each tool, by name.
 *
 * The registry is data, not code: each tool is one entry in TOOLS with
 * a detect command, install steps, and prereqs. Adding a new tool is
 * a one-record diff. Installing always shows the user what's about to
 * run before running it; nothing in this module spawns a sudo or pipes
 * a remote script into a shell behind the user's back.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasBin } from './detect.js';

const execFileAsync = promisify(execFile);

export type InstallStepKind =
  | 'cargo-install'   // `cargo install <pkg>` — needs Rust toolchain
  | 'npm-global'      // `npm install -g <pkg>` — needs Node (always present)
  | 'shell-script'    // `curl … | sh` — only when the upstream publishes
                      // a verifiable installer; we surface the URL up-front
  | 'manual';         // No automated path; print install instructions

export interface InstallStep {
  kind:    InstallStepKind;
  // Display string the user sees before confirming. For automated steps
  // this is the literal command we run; for `manual` it's the prose
  // instruction we print.
  display: string;
  // For automated steps only — the argv we pass to execFile. `manual`
  // steps leave this null.
  argv:    [string, ...string[]] | null;
}

export interface Tool {
  id:          string;
  name:        string;
  description: string;
  // The argv we run to detect installation. First success counts.
  // `<binary> --version` is the convention; some tools use `version`
  // or `-V`. We swallow non-zero exits and parse the first non-empty
  // stdout line as the version string.
  detect:      [string, ...string[]];
  // Which binary on PATH counts as "installed". detect.argv[0] usually
  // matches this; kept separate so a tool can be installed under one
  // binary name and probed via a different alias.
  binary:      string;
  prereqs?:    string[];      // human-readable; surfaced in the UI before install
  // Sequence run in order on `nostr-station add`. We display all steps
  // first, then confirm, then run. Manual steps short-circuit the run
  // — the user does them by hand and re-runs `add` to verify.
  installSteps: InstallStep[];
}

export interface DetectResult {
  installed: boolean;
  version:   string | null;   // first stdout line, trimmed, or null when probe failed
  error?:    string;
}

export interface InstallResult {
  ok:    boolean;
  ranSteps: number;
  detail?: string;
}

// ── Registry ───────────────────────────────────────────────────────────────

export const TOOLS: Record<string, Tool> = {
  ngit: {
    id:          'ngit',
    name:        'ngit',
    description: 'Nostr-native git remote — push commits + signed events to Nostr relays.',
    binary:      'ngit',
    detect:      ['ngit', '--version'],
    prereqs:     ['Rust toolchain (rustup) — install at https://rustup.rs'],
    installSteps: [
      { kind: 'cargo-install', display: 'cargo install ngit', argv: ['cargo', 'install', 'ngit'] },
    ],
  },

  nak: {
    id:          'nak',
    name:        'nak',
    description: 'Nostr Army Knife — CLI for poking at relays, events, and keys.',
    binary:      'nak',
    detect:      ['nak', '--version'],
    prereqs:     ['Rust toolchain (rustup) — install at https://rustup.rs'],
    installSteps: [
      { kind: 'cargo-install', display: 'cargo install nak', argv: ['cargo', 'install', 'nak'] },
    ],
  },

  stacks: {
    id:          'stacks',
    name:        'Stacks',
    description: 'Soapbox Stacks — scaffold Nostr apps with `stacks mkstack`.',
    binary:      'stacks',
    detect:      ['stacks', '--version'],
    installSteps: [
      { kind: 'npm-global', display: 'npm install -g @getstacks/stacks', argv: ['npm', 'install', '-g', '@getstacks/stacks'] },
    ],
  },

  nsyte: {
    id:          'nsyte',
    name:        'nsyte',
    description: 'Static-site publishing to nsite — Amber-signed, no nsec on machine.',
    binary:      'nsyte',
    detect:      ['nsyte', '--version'],
    // nsyte ships an official curl|bash installer at nsyte.run. We
    // surface the URL so the user can read it before approving — no
    // silent pipe-to-shell. If the user prefers, the listed URL is the
    // same one published in nsyte's README.
    installSteps: [
      {
        kind:    'manual',
        display: 'Run the official installer: curl -fsSL https://nsyte.run/install.sh | sh',
        argv:    null,
      },
    ],
  },
};

// ── Detection ──────────────────────────────────────────────────────────────

export async function detectTool(t: Tool): Promise<DetectResult> {
  if (!hasBin(t.binary)) {
    return { installed: false, version: null };
  }
  // Some tools print the version to stderr (cargo-installed Rust crates
  // commonly do). We capture both and return whichever is non-empty.
  try {
    const r = await execFileAsync(t.detect[0], t.detect.slice(1), { timeout: 5000 });
    const out = (r.stdout || r.stderr || '').split('\n')[0]?.trim() || null;
    return { installed: true, version: out };
  } catch (e: any) {
    // Binary exists but the probe failed — treat as installed (it's on
    // PATH) but unknown version. Surfaces as "✓ installed" without a
    // version string in the UI.
    return { installed: true, version: null, error: e?.message };
  }
}

// ── Installation ───────────────────────────────────────────────────────────
//
// Runs the tool's installSteps sequentially, streaming each line of
// stdout/stderr to onProgress. Bails on the first non-zero exit;
// returns ok:false with the failing step's detail. `manual` steps
// short-circuit the run and return ok:false — the caller renders the
// instruction and asks the user to do it by hand.

export async function installTool(
  t:          Tool,
  onProgress: (line: string) => void,
): Promise<InstallResult> {
  let ran = 0;
  for (const step of t.installSteps) {
    if (step.kind === 'manual') {
      // No automated path — short-circuit. UI surfaces the display string.
      return { ok: false, ranSteps: ran, detail: step.display };
    }
    if (!step.argv) {
      return { ok: false, ranSteps: ran, detail: 'install step missing argv' };
    }
    onProgress(`▸ ${step.display}`);
    const stepResult = await runStep(step.argv, onProgress);
    if (!stepResult.ok) {
      return { ok: false, ranSteps: ran, detail: stepResult.detail || `step failed: ${step.display}` };
    }
    ran++;
  }
  return { ok: true, ranSteps: ran };
}

async function runStep(
  argv:       [string, ...string[]],
  onProgress: (line: string) => void,
): Promise<{ ok: boolean; detail?: string }> {
  // Stream stdout + stderr line-by-line so the UI can render progress.
  // execFileAsync would buffer everything to the end of the run, which
  // makes a 3-minute cargo install look like a 3-minute hang.
  const { spawn } = await import('node:child_process');
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    const pipeLines = (chunk: Buffer, isStderr: boolean) => {
      const text = chunk.toString();
      if (isStderr) stderrTail = (stderrTail + text).slice(-2000);
      for (const line of text.split('\n')) {
        if (line.trim()) onProgress(line);
      }
    };
    child.stdout.on('data', c => pipeLines(c, false));
    child.stderr.on('data', c => pipeLines(c, true));
    child.on('error', e => resolve({ ok: false, detail: `spawn failed: ${e.message}` }));
    child.on('close', code => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, detail: `exit ${code}${stderrTail ? '\n' + stderrTail.trim() : ''}` });
    });
  });
}

// ── Lookup helpers ─────────────────────────────────────────────────────────

export function getTool(id: string): Tool | null {
  return TOOLS[id] ?? null;
}

export function listTools(): Tool[] {
  return Object.values(TOOLS);
}
