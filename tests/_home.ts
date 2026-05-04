// Test helper: isolate HOME so modules that persist to ~/.nostr-station,
// ~/.config/nostr-station, ~/.claude_env, etc. don't touch the real user
// home. Call `useTempHome()` at the TOP of a test file (before any imports
// that resolve paths at module load) to pin a fresh tmpdir for the file.
// Returns the path so tests can seed fixtures inside it.
//
// Rationale for the early-call pattern: ai-config.ts caches
// `path.join(os.homedir(), '.nostr-station')` into a module-level constant
// at import time. If HOME is set after import, those constants still point
// at the real home. So the pattern is:
//
//   import { useTempHome } from './_home.js';
//   const HOME = useTempHome();
//   const { readAiConfig } = await import('../src/lib/ai-config.js');

import fs from 'fs';
import os from 'os';
import path from 'path';

// Seed a minimal global git config so tests that shell out to
// `git commit` (e.g. snapshotProject in sync.test.ts) have an
// identity to attach. Without this, CI runners — which have no
// global git identity — fail the commit because HOME is redirected
// to the tmpdir and the runner's global config is invisible.
function seedGitConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, '.gitconfig'),
    '[user]\n\tname = nostr-station tests\n\temail = tests@nostr-station.local\n',
  );
}

export function useTempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostr-station-test-'));
  process.env.HOME = dir;
  // Some libs (and os.homedir() on Windows) read USERPROFILE instead.
  process.env.USERPROFILE = dir;
  seedGitConfig(dir);
  return dir;
}

export function resetTempHome(dir: string): void {
  // Wipe everything under the temp home between tests so stale state from
  // one test can't leak into the next. Safe because each file makes its
  // own tmpdir — we're only clearing what this file created.
  for (const entry of fs.readdirSync(dir)) {
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
  // Re-seed after wipe — the .gitconfig from useTempHome was just deleted.
  seedGitConfig(dir);
}
