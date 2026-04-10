import { execSync } from 'child_process';
import { execa, type ExecaError } from 'execa';

export interface Remote {
  name: string;
  url: string;
  type: 'github' | 'ngit' | 'other';
}

export interface Commit {
  hash: string;
  message: string;
  age: string;
}

export interface PushResult {
  remote: string;
  type: Remote['type'];
  ok: boolean;
  detail?: string;
}

function cmd(c: string): string | null {
  try { return execSync(c, { stdio: 'pipe' }).toString().trim(); }
  catch { return null; }
}

function has(bin: string): boolean {
  return cmd(`command -v ${bin}`) !== null;
}

// ── Remote detection ───────────────────────────────────────────────────────

export function getRemotes(): Remote[] {
  const raw = cmd('git remote -v');
  if (!raw) return [];

  const seen = new Set<string>();
  const remotes: Remote[] = [];

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\(fetch\)/);
    if (!match) continue;
    const [, name, url] = match;
    if (seen.has(name)) continue;
    seen.add(name);

    let type: Remote['type'] = 'other';
    if (url.includes('github.com')) type = 'github';
    else if (url.startsWith('naddr') || url.startsWith('nostr:') || url.includes('.nostr')) type = 'ngit';

    remotes.push({ name, url, type });
  }

  return remotes;
}

export function isNgitConfigured(): boolean {
  if (!has('ngit')) return false;
  // ngit is configured for a repo if `ngit list` exits 0 and returns output
  const out = cmd('ngit list 2>/dev/null');
  return out !== null && out.length > 0;
}

// ── Commit log ─────────────────────────────────────────────────────────────

export function getUnpushedCommits(remoteName = 'origin'): Commit[] {
  const fmt = '--format=%H|%s|%cr';

  // Try tracking branch first
  let raw = cmd(`git log ${fmt} @{u}..HEAD 2>/dev/null`);

  // Fallback: try <remote>/main then <remote>/master
  if (raw === null) {
    raw = cmd(`git log ${fmt} ${remoteName}/main..HEAD 2>/dev/null`);
  }
  if (raw === null) {
    raw = cmd(`git log ${fmt} ${remoteName}/master..HEAD 2>/dev/null`);
  }
  // Last resort: recent commits (can't determine what's pushed)
  if (raw === null) {
    raw = cmd(`git log ${fmt} -5 HEAD 2>/dev/null`);
  }

  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    const [hash, message, age] = line.split('|');
    return { hash: hash?.slice(0, 7) ?? '', message: message ?? '', age: age ?? '' };
  });
}

export function getCurrentBranch(): string {
  return cmd('git branch --show-current') ?? 'main';
}

export function isGitRepo(): boolean {
  return cmd('git rev-parse --git-dir 2>/dev/null') !== null;
}

// ── Push execution ─────────────────────────────────────────────────────────

export async function pushToRemote(remote: Remote, branch: string): Promise<PushResult> {
  try {
    if (remote.type === 'ngit') {
      await execa('ngit', ['push'], { stdio: 'pipe' });
    } else {
      // Use gh for github remotes if available, otherwise plain git push
      await execa('git', ['push', remote.name, branch], { stdio: 'pipe' });
    }
    return { remote: remote.name, type: remote.type, ok: true };
  } catch (e) {
    const err = e as ExecaError;
    return {
      remote: remote.name,
      type: remote.type,
      ok: false,
      detail: err.stderr?.toString().trim().split('\n').pop()?.slice(0, 80),
    };
  }
}
