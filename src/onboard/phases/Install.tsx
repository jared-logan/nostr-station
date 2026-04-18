import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step, type StepStatus } from '../components/Step.js';
import { Select } from '../components/Select.js';
import { P } from '../components/palette.js';
import type { Platform, Config, Installed } from '../../lib/detect.js';
import {
  installSystemDeps, installRust, installCargoBin, installNak, installRelayPrebuilt,
  installNodePtyPrebuilt,
  installClaudeCode, installGitHubCLI, installStacks, installBlossom, installNsyte,
} from '../../lib/install.js';
import type { InstallResult } from '../../lib/install.js';
import { openInstallLog } from '../../lib/install-log.js';

interface StepState {
  label: string;
  status: StepStatus;
  detail?: string;
}

interface InstallPhaseProps {
  platform: Platform;
  installed: Installed;
  config: Config;
  // True when cli.tsx already ran the package-manager install pre-Ink.
  // Skip the in-TUI call and render the row as done. See cli.tsx onboard
  // case for the Ink+sudo+apt hang this works around.
  systemDepsPreInstalled?: boolean;
  onDone: () => void;
}

// Compiled-from-source bins.
//   - nak is NOT here — Go binary distributed as prebuilt on GitHub Releases;
//     see installNak in src/lib/install.ts.
//   - nostr-rs-relay is NOT here — tries a prebuilt download first (hosted on
//     this repo's releases) and falls back to `cargo install` on failure;
//     see installRelayPrebuilt in src/lib/install.ts.
const CARGO_BINS = [
  { pkg: 'ngit', label: 'ngit  (compiling…)' },
];

export const InstallPhase: React.FC<InstallPhaseProps> = ({
  platform, installed, config, systemDepsPreInstalled = false, onDone,
}) => {
  const initial: StepState[] = [
    { label: 'System packages',  status: systemDepsPreInstalled ? 'done' : 'pending',
                                 detail:  systemDepsPreInstalled ? 'installed pre-TUI' : undefined },
    { label: 'Rust toolchain',   status: 'pending' },
    // Relay: prebuilt-first, compile fallback. Row ordering matches IDX below.
    { label: 'nostr-rs-relay',   status: 'pending' },
    // one row per cargo bin — label updates live during compile
    ...CARGO_BINS.map(b => ({ label: b.label, status: 'pending' as StepStatus })),
    { label: 'nak',              status: 'pending' },
    // Web terminal runtime — enables the xterm.js panel in the dashboard.
    // Tries our prebuilt first (4 arches, see release-node-pty-prebuilts.yml);
    // compile fallback requires python3 + build tools. Non-fatal on failure.
    { label: 'Web terminal',     status: 'pending' },
    { label: 'Claude Code',      status: (config.aiProvider === 'anthropic' || config.editor === 'claude-code') ? 'pending' : 'skip' as StepStatus },
    { label: 'GitHub CLI',       status: config.versionControl !== 'ngit' ? 'pending' : 'skip' as StepStatus },
    { label: 'Stacks',           status: config.installStacks  ? 'pending' : 'skip' as StepStatus },
    { label: 'Blossom server',   status: config.installBlossom ? 'pending' : 'skip' as StepStatus },
    { label: 'nsyte',            status: config.installNsyte   ? 'pending' : 'skip' as StepStatus },
  ];

  const [steps, setSteps] = useState<StepState[]>(initial);
  const [finished, setFinished] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  // Stable index offsets
  const IDX = {
    sys:     0,
    rust:    1,
    relay:   2,
    ngit:    3,
    nak:     4,
    nodePty: 5,
    claude:  6,
    gh:      7,
    stacks:  8,
    blossom: 9,
    nsyte:   10,
  };

  const update = (i: number, patch: Partial<StepState>) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  useEffect(() => {
    setFinished(false);
    setSteps(initial);
    (async () => {
      // Durable post-mortem for the Install phase. Every step's progress
      // updates, final status, and — for cargo compiles — the full stderr
      // land here. When ngit silently fails on fresh Mint boxes, the user
      // can cat this file instead of asking us what went wrong.
      const log = openInstallLog();
      log.append('── install phase start ──');
      log.append(`platform=${platform.os}/${platform.arch} pkgMgr=${platform.pkgMgr} cargoBin=${platform.cargoBin}`);

      // Single wrapper for all 11 install steps. Hides the `update + await
      // + update-with-result` boilerplate and guarantees every step is
      // mirrored to the log. `runner` can stream progress + append raw
      // stderr lines (the latter is what rescues A6 — ngit cargo compile
      // failures were previously invisible beyond the 120-char slice).
      async function instrumentStep(
        label: string,
        idx: number,
        runner: (
          onProgress: (detail: string) => void,
          appendLog: (line: string) => void,
        ) => Promise<InstallResult>,
        opts: {
          initialDetail?: string;
          // node-pty decorates its error with " — terminal panel disabled".
          formatDetail?: (r: InstallResult) => string | undefined;
        } = {},
      ): Promise<InstallResult> {
        update(idx, { status: 'running', detail: opts.initialDetail });
        log.append(`── ${label} start ──`);
        const onProgress = (detail: string): void => {
          update(idx, { detail });
          log.append(`${label}: ${detail}`);
        };
        const appendLog = (line: string): void => log.append(`${label}: ${line}`);
        const r = await runner(onProgress, appendLog);
        const detail = opts.formatDetail ? opts.formatDetail(r) : r.detail;
        update(idx, { status: r.ok ? 'done' : 'error', detail });
        log.append(
          `${label}: ${r.ok ? `DONE${detail ? ` (${detail})` : ''}` : `FAIL ${detail ?? '(no detail)'}`}`,
        );
        return r;
      }

      // System deps — stream apt/brew progress so the user sees
      // "Reading package lists…" / "Unpacking libssl-dev…" instead of a
      // frozen spinner. Without streaming, a healthy apt run on a cold
      // runner looks indistinguishable from a hang.
      //
      // On Linux interactive (non-demo) runs, cli.tsx already installed
      // system packages pre-Ink to dodge the sudo-inside-Ink hang; in
      // that case the initial row is already 'done' and we skip the call.
      if (!systemDepsPreInstalled) {
        await instrumentStep('System packages', IDX.sys,
          (onProgress) => installSystemDeps(platform, onProgress),
          { initialDetail: 'starting…' });
      }

      // Rust
      await instrumentStep('Rust toolchain', IDX.rust, () => installRust());

      // nostr-rs-relay — try the prebuilt from this repo's releases, fall
      // back to cargo compile on any failure. installRelayPrebuilt owns the
      // decision; we just render whatever detail it reports (which will
      // flip to "compiling…" with live cargo output during fallback).
      await instrumentStep('nostr-rs-relay', IDX.relay,
        (onProgress, appendLog) => installRelayPrebuilt(platform.cargoBin, onProgress, appendLog),
        { initialDetail: 'resolving…' });

      // Cargo bins (just ngit now) — streams live compiler progress.
      // appendLog threads the full cargo stderr into ~/logs/install.log,
      // rescuing A6: the "unknown error" ngit compile failures now leave
      // a post-mortem instead of scrolling off the TUI.
      for (const { pkg, label } of CARGO_BINS) {
        const r = await instrumentStep(label, IDX.ngit,
          (onProgress, appendLog) => installCargoBin(pkg, onProgress, appendLog),
          { initialDetail: 'starting…' });
        update(IDX.ngit, { label: pkg });  // clean label once done
        if (!r.ok) break;
      }

      // nak — prebuilt Go binary from GitHub Releases (NOT a cargo install).
      // Runs independently of the cargo loop above: even if relay/ngit failed
      // to compile, we can still lay down nak.
      await instrumentStep('nak', IDX.nak,
        () => installNak(platform.cargoBin),
        { initialDetail: 'downloading…' });

      // node-pty — native PTY addon powering the dashboard terminal panel.
      // Prebuilt-first (hosted on this repo's releases), compile fallback on
      // any failure. Non-fatal: if node-pty can't be installed, the terminal
      // panel is simply disabled; the rest of the dashboard works unchanged.
      await instrumentStep('Web terminal', IDX.nodePty,
        (onProgress) => installNodePtyPrebuilt(onProgress),
        {
          initialDetail: 'resolving…',
          formatDetail: (r) => r.ok ? r.detail : `${r.detail ?? 'failed'} — terminal panel disabled`,
        });

      // Claude Code — only if using Anthropic or Claude Code as editor
      const shouldInstallClaudeCode = config.aiProvider === 'anthropic' || config.editor === 'claude-code';
      if (shouldInstallClaudeCode) {
        await instrumentStep('Claude Code', IDX.claude, () => installClaudeCode());
      } else {
        update(IDX.claude, { label: 'Claude Code   (not needed for your configuration)', status: 'skip' });
        log.append('Claude Code: SKIP (not needed for this configuration)');
      }

      // GitHub CLI
      if (config.versionControl !== 'ngit') {
        await instrumentStep('GitHub CLI', IDX.gh, () => installGitHubCLI(platform));
      }

      // Stacks
      if (config.installStacks) {
        await instrumentStep('Stacks', IDX.stacks, () => installStacks());
      }

      // Blossom
      if (config.installBlossom) {
        await instrumentStep('Blossom server', IDX.blossom, () => installBlossom(platform.homeDir));
      }

      // nsyte
      if (config.installNsyte) {
        await instrumentStep('nsyte', IDX.nsyte, () => installNsyte());
      }

      log.append('── install phase end ──');
      setFinished(true);
    })();
  }, [retryCount]);

  // Only relay + ngit compile from source — nak is a prebuilt download.
  const compiling = steps.slice(IDX.relay, IDX.ngit + 1).some(s => s.status === 'running');
  const hasError  = finished && steps.some(s => s.status === 'error');
  const allOk     = finished && !hasError;

  // Ink's <Select> uses useInput, which calls stdin.setRawMode(true) on
  // mount and hard-throws "Raw mode is not supported" if stdin isn't a
  // TTY (CI with `< /dev/null`, piped input, etc.). Without this guard
  // the error crashes the whole UI and clobbers prior step output via
  // Ink's screen-rewrite, making diagnosis of the ORIGINAL failure
  // nearly impossible. When we can't render the interactive recovery
  // menu, we (a) print the failing step details to stderr so they
  // survive the screen rewrite, and (b) fall through the recovery by
  // calling onDone() — the downstream Verify phase will report the
  // missing artifacts.
  const canPrompt = !!process.stdin.isTTY;
  useEffect(() => {
    if (!hasError || canPrompt) return;
    const failures = steps
      .filter(s => s.status === 'error')
      .map(s => `  - ${s.label}${s.detail ? `: ${s.detail}` : ''}`)
      .join('\n');
    process.stderr.write(
      `\n[install] one or more steps failed (non-interactive, skipping recovery prompt):\n${failures}\n`
      + `[install] full log: ~/logs/install.log\n`,
    );
    onDone();
  }, [hasError, canPrompt]);

  if (allOk) setTimeout(onDone, 300);

  return (
    <Box flexDirection="column">
      <PhaseHeader number={3} title="Core Runtime" />
      {steps.map((s, i) => (
        <Step key={i} label={s.label} status={s.status} detail={s.detail} />
      ))}
      {compiling && (
        <Box marginLeft={6} marginTop={0}>
          <Text color={P.muted}>
            {'Rust compilation takes 5–15 min on first install. This is normal.'}
          </Text>
        </Box>
      )}
      {hasError && canPrompt && (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>
            {'Full log: ~/logs/install.log'}
          </Text>
          <Select
            label="One or more steps failed — what would you like to do?"
            options={[
              { label: 'Retry (restart install from scratch)', value: 'retry'    },
              { label: 'Continue anyway',                      value: 'continue' },
            ]}
            onSelect={item => {
              if (item.value === 'retry') setRetryCount(c => c + 1);
              else onDone();
            }}
          />
        </Box>
      )}
      {hasError && !canPrompt && (
        <Box marginTop={1} marginLeft={2}>
          <Text color={P.error}>
            Non-interactive mode — one or more steps failed (see stderr). Continuing.
          </Text>
        </Box>
      )}
    </Box>
  );
};
