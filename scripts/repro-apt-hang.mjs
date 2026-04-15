#!/usr/bin/env node
// Bisect the "apt-get update hangs inside onboard" bug on Linux Mint.
//
// Runs `sudo -n apt-get update -qq` under several spawn configurations,
// with a hard 30s timeout per variant. While each child is alive, samples
// /proc/<pid>/wchan to record what it's waiting on. Prints a summary.
//
// Run on the affected Mint box AFTER `sudo -v` to warm the cred cache:
//
//     sudo -v && node scripts/repro-apt-hang.mjs
//
// If `sudo -n true` also hangs, the problem is sudo+PAM, not apt.
// If only the pipe variants hang, it's pipe/stdio. If `detached: true`
// fixes it, it's controlling-TTY / process-group.

import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';

const TIMEOUT_MS = 30_000;
const WCHAN_SAMPLE_MS = 2_000;

// Match runApt()'s env.
const APT_ENV = {
  ...process.env,
  DEBIAN_FRONTEND: 'noninteractive',
  NEEDRESTART_MODE: 'a',
  NEEDRESTART_SUSPEND: '1',
};

const SUDO_ARGS = [
  '-n',
  '--preserve-env=DEBIAN_FRONTEND,NEEDRESTART_MODE,NEEDRESTART_SUSPEND',
];

// Recursively sample wchan of the child AND its descendants, so if sudo
// has fork-exec'd apt-get, we see what apt-get is stuck on too.
async function sampleTree(rootPid, stopRef) {
  const seen = new Map(); // pid -> samples[]
  while (!stopRef.stop) {
    const pids = await descendants(rootPid);
    for (const pid of pids) {
      if (!seen.has(pid)) seen.set(pid, []);
      try {
        const [wchan, status, comm] = await Promise.all([
          readFile(`/proc/${pid}/wchan`, 'utf8').catch(() => '?'),
          readFile(`/proc/${pid}/status`, 'utf8').catch(() => ''),
          readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '?'),
        ]);
        const state = status.match(/^State:\s+(\S.*)$/m)?.[1] ?? '?';
        const stamp = new Date().toISOString().slice(11, 19);
        seen.get(pid).push(`${stamp} ${comm.trim()}(${pid}) wchan=${wchan.trim() || '(none)'} state=${state}`);
      } catch {}
    }
    await sleep(WCHAN_SAMPLE_MS);
  }
  return seen;
}

async function descendants(rootPid) {
  // Walk /proc/*/status for PPid matches, transitively.
  const out = new Set([rootPid]);
  const entries = await readdir('/proc').catch(() => []);
  const allPids = entries.filter(n => /^\d+$/.test(n)).map(Number);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pid of allPids) {
      if (out.has(pid)) continue;
      try {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        const ppid = Number(status.match(/^PPid:\s+(\d+)$/m)?.[1]);
        if (out.has(ppid)) { out.add(pid); changed = true; }
      } catch {}
    }
  }
  return [...out];
}

async function runVariant(name, cmd, args, opts) {
  const start = Date.now();
  process.stdout.write(`\n=== ${name}\n`);
  process.stdout.write(`    cmd:  ${cmd} ${args.join(' ')}\n`);
  process.stdout.write(`    opts: ${JSON.stringify({ stdio: opts.stdio, detached: opts.detached ?? false })}\n`);

  const child = spawn(cmd, args, { ...opts, env: APT_ENV });
  const stopRef = { stop: false };
  const treeSamples = sampleTree(child.pid, stopRef);

  // Drain any pipes so pipe-buffer-fill isn't the bug we observe.
  let stdoutBytes = 0, stderrBytes = 0;
  let lastStderr = '';
  child.stdout?.on('data', b => { stdoutBytes += b.length; });
  child.stderr?.on('data', b => {
    stderrBytes += b.length;
    lastStderr = b.toString().trim().split('\n').pop() ?? lastStderr;
  });

  const result = await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { process.kill(child.pid, 'SIGKILL'); } catch {}
      resolve({ timedOut: true });
    }, TIMEOUT_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
    child.on('error', err => {
      clearTimeout(timer);
      resolve({ error: err.message, timedOut: false });
    });
  });

  stopRef.stop = true;
  const samples = await treeSamples;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  process.stdout.write(`    → ${result.timedOut ? 'HANG (killed)' : `exit=${result.code ?? 'sig:' + result.signal}`}`);
  process.stdout.write(`  elapsed=${elapsed}s  stdout=${stdoutBytes}B  stderr=${stderrBytes}B\n`);
  if (lastStderr) process.stdout.write(`    last stderr line: ${lastStderr.slice(0, 160)}\n`);

  // Print the last sample per pid — usually enough to see where each was stuck.
  if (result.timedOut) {
    process.stdout.write(`    wait-channel trace:\n`);
    for (const [pid, series] of samples) {
      const last = series[series.length - 1];
      if (last) process.stdout.write(`      pid ${pid}: ${last}\n`);
    }
  }

  return { name, ...result, elapsedSec: Number(elapsed), stdoutBytes, stderrBytes, lastStderr };
}

async function main() {
  if (process.platform !== 'linux') {
    console.error('This repro targets Linux (Mint). Aborting on', process.platform);
    process.exit(2);
  }

  process.stdout.write(`sudo -v status: `);
  await new Promise(r => {
    const p = spawn('sudo', ['-n', 'true'], { stdio: 'ignore' });
    p.on('exit', code => {
      process.stdout.write(code === 0 ? 'cached ✓\n' : `NOT cached (exit ${code}) — run \`sudo -v\` first!\n`);
      r();
    });
  });

  const variants = [
    // 1) Baseline: exactly what runApt() does today.
    {
      name: '1. baseline (current runApt): stdio=ignore,pipe,pipe',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'apt-get', 'update', '-qq'],
      opts: { stdio: ['ignore', 'pipe', 'pipe'] },
    },
    // 2) + detached — new process group, no inherited controlling TTY.
    {
      name: '2. baseline + detached:true',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'apt-get', 'update', '-qq'],
      opts: { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    },
    // 3) stdio all ignored — removes pipes entirely.
    {
      name: '3. stdio=ignore (all three)',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'apt-get', 'update', '-qq'],
      opts: { stdio: 'ignore' },
    },
    // 4) stdio inherit — what the shell does.
    {
      name: '4. stdio=inherit (shell-like)',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'apt-get', 'update', '-qq'],
      opts: { stdio: 'inherit' },
    },
    // 5) Drop -qq — see if apt emits something before wedging.
    {
      name: '5. no -qq: full stderr',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'apt-get', 'update'],
      opts: { stdio: ['ignore', 'pipe', 'pipe'] },
    },
    // 6) Does SUDO itself hang with this stdio, independent of apt?
    {
      name: '6. sudo -n true (isolates sudo from apt)',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'true'],
      opts: { stdio: ['ignore', 'pipe', 'pipe'] },
    },
    // 7) Same, detached — rules in/out TTY-for-sudo-PAM.
    {
      name: '7. sudo -n true + detached',
      cmd: 'sudo',
      args: [...SUDO_ARGS, 'true'],
      opts: { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
    },
  ];

  const results = [];
  for (const v of variants) {
    results.push(await runVariant(v.name, v.cmd, v.args, v.opts));
  }

  process.stdout.write('\n=== SUMMARY\n');
  for (const r of results) {
    const status = r.timedOut ? 'HANG' : r.code === 0 ? 'OK' : `FAIL(${r.code ?? r.signal})`;
    process.stdout.write(`  ${status.padEnd(7)} ${r.elapsedSec}s  ${r.name}\n`);
  }

  process.stdout.write('\nInterpretation guide:\n');
  process.stdout.write('  - (6) hangs  → sudo+PAM is the problem, apt is a red herring.\n');
  process.stdout.write('  - (6) OK, (1) hangs, (2) OK → TTY/process-group — add detached:true to runApt.\n');
  process.stdout.write('  - (1) hangs, (3) OK → pipe handling specifically. (4) tells us if inherit works.\n');
  process.stdout.write('  - (5) produces output then wedges → a specific apt post-invoke hook.\n');
}

main().catch(e => { console.error(e); process.exit(1); });
