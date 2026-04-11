import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step, type StepStatus } from '../components/Step.js';
import { Select } from '../components/Select.js';
import { P } from '../components/palette.js';
import type { Platform, Config, Installed } from '../../lib/detect.js';
import {
  installSystemDeps, installRust, installCargoBin, installNak, installRelayPrebuilt,
  installClaudeCode, installGitHubCLI, installStacks, installBlossom, installNsyte,
} from '../../lib/install.js';

interface StepState {
  label: string;
  status: StepStatus;
  detail?: string;
}

interface InstallPhaseProps {
  platform: Platform;
  installed: Installed;
  config: Config;
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
  platform, installed, config, onDone,
}) => {
  const initial: StepState[] = [
    { label: 'System packages',  status: 'pending' },
    { label: 'Rust toolchain',   status: 'pending' },
    // Relay: prebuilt-first, compile fallback. Row ordering matches IDX below.
    { label: 'nostr-rs-relay',   status: 'pending' },
    // one row per cargo bin — label updates live during compile
    ...CARGO_BINS.map(b => ({ label: b.label, status: 'pending' as StepStatus })),
    { label: 'nak',              status: 'pending' },
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
    sys:    0,
    rust:   1,
    relay:  2,
    ngit:   3,
    nak:    4,
    claude: 5,
    gh:     6,
    stacks: 7,
    blossom:8,
    nsyte:  9,
  };

  const update = (i: number, patch: Partial<StepState>) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  useEffect(() => {
    setFinished(false);
    setSteps(initial);
    (async () => {
      // System deps — stream apt/brew progress so the user sees
      // "Reading package lists…" / "Unpacking libssl-dev…" instead of a
      // frozen spinner. Without streaming, a healthy apt run on a cold
      // runner looks indistinguishable from a hang.
      update(IDX.sys, { status: 'running', detail: 'starting…' });
      const sys = await installSystemDeps(platform, (detail) => {
        update(IDX.sys, { detail });
      });
      update(IDX.sys, { status: sys.ok ? 'done' : 'error', detail: sys.detail });

      // Rust
      update(IDX.rust, { status: 'running' });
      const rust = await installRust();
      update(IDX.rust, { status: rust.ok ? 'done' : 'error', detail: rust.detail });

      // nostr-rs-relay — try the prebuilt from this repo's releases, fall
      // back to cargo compile on any failure. installRelayPrebuilt owns the
      // decision; we just render whatever detail it reports (which will
      // flip to "compiling…" with live cargo output during fallback).
      update(IDX.relay, { status: 'running', detail: 'resolving…' });
      const relay = await installRelayPrebuilt(platform.cargoBin, (detail) => {
        update(IDX.relay, { detail });
      });
      update(IDX.relay, {
        status: relay.ok ? 'done' : 'error',
        detail: relay.detail,
      });

      // Cargo bins (just ngit now) — streams live compiler progress.
      for (const { pkg, label } of CARGO_BINS) {
        const idx = IDX.ngit;
        update(idx, { status: 'running', label, detail: 'starting…' });

        const r = await installCargoBin(pkg, (detail) => {
          update(idx, { detail });
        });

        update(idx, {
          label: pkg,   // clean label once done
          status: r.ok ? 'done' : 'error',
          detail: r.detail,
        });
        if (!r.ok) break;
      }

      // nak — prebuilt Go binary from GitHub Releases (NOT a cargo install).
      // Runs independently of the cargo loop above: even if relay/ngit failed
      // to compile, we can still lay down nak.
      update(IDX.nak, { status: 'running', detail: 'downloading…' });
      const nak = await installNak(platform.cargoBin);
      update(IDX.nak, { status: nak.ok ? 'done' : 'error', detail: nak.detail });

      // Claude Code — only if using Anthropic or Claude Code as editor
      const shouldInstallClaudeCode = config.aiProvider === 'anthropic' || config.editor === 'claude-code';
      if (shouldInstallClaudeCode) {
        update(IDX.claude, { status: 'running' });
        const cc = await installClaudeCode();
        update(IDX.claude, { status: cc.ok ? 'done' : 'error', detail: cc.detail });
      } else {
        update(IDX.claude, { label: 'Claude Code   (not needed for your configuration)', status: 'skip' });
      }

      // GitHub CLI
      if (config.versionControl !== 'ngit') {
        update(IDX.gh, { status: 'running' });
        const gh = await installGitHubCLI(platform);
        update(IDX.gh, { status: gh.ok ? 'done' : 'error', detail: gh.detail });
      }

      // Stacks
      if (config.installStacks) {
        update(IDX.stacks, { status: 'running' });
        const st = await installStacks();
        update(IDX.stacks, { status: st.ok ? 'done' : 'error', detail: st.detail });
      }

      // Blossom
      if (config.installBlossom) {
        update(IDX.blossom, { status: 'running' });
        const bl = await installBlossom(platform.homeDir);
        update(IDX.blossom, { status: bl.ok ? 'done' : 'error', detail: bl.detail });
      }

      // nsyte
      if (config.installNsyte) {
        update(IDX.nsyte, { status: 'running' });
        const ns = await installNsyte();
        update(IDX.nsyte, { status: ns.ok ? 'done' : 'error', detail: ns.detail });
      }

      setFinished(true);
    })();
  }, [retryCount]);

  // Only relay + ngit compile from source — nak is a prebuilt download.
  const compiling = steps.slice(IDX.relay, IDX.ngit + 1).some(s => s.status === 'running');
  const hasError  = finished && steps.some(s => s.status === 'error');
  const allOk     = finished && !hasError;

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
      {hasError && (
        <Box marginTop={1} flexDirection="column">
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
    </Box>
  );
};
