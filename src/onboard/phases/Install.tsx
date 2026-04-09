import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step, type StepStatus } from '../components/Step.js';
import { Select } from '../components/Select.js';
import { P } from '../components/palette.js';
import type { Platform, Config, Installed } from '../../lib/detect.js';
import {
  installSystemDeps, installRust, installCargoBin,
  installClaudeCode, installStacks, installBlossom,
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

const CARGO_BINS = [
  { pkg: 'nostr-rs-relay', label: 'nostr-rs-relay  (compiling…)' },
  { pkg: 'ngit',           label: 'ngit  (compiling…)' },
  { pkg: 'nak',            label: 'nak' },
];

export const InstallPhase: React.FC<InstallPhaseProps> = ({
  platform, installed, config, onDone,
}) => {
  const initial: StepState[] = [
    { label: 'System packages',  status: 'pending' },
    { label: 'Rust toolchain',   status: 'pending' },
    // one row per cargo bin — label updates live during compile
    ...CARGO_BINS.map(b => ({ label: b.label, status: 'pending' as StepStatus })),
    { label: 'Claude Code',      status: 'pending' },
    { label: 'Stacks',           status: config.installStacks  ? 'pending' : 'skip' as StepStatus },
    { label: 'Blossom server',   status: config.installBlossom ? 'pending' : 'skip' as StepStatus },
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
    stacks: 6,
    blossom:7,
  };

  const update = (i: number, patch: Partial<StepState>) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  useEffect(() => {
    setFinished(false);
    setSteps(initial);
    (async () => {
      // System deps
      update(IDX.sys, { status: 'running' });
      const sys = await installSystemDeps(platform);
      update(IDX.sys, { status: sys.ok ? 'done' : 'error', detail: sys.detail });

      // Rust
      update(IDX.rust, { status: 'running' });
      const rust = await installRust();
      update(IDX.rust, { status: rust.ok ? 'done' : 'error', detail: rust.detail });

      // Cargo bins — each streams live compiler progress into the step detail
      for (const { pkg, label } of CARGO_BINS) {
        const idx = IDX[pkg === 'nostr-rs-relay' ? 'relay' : pkg === 'ngit' ? 'ngit' : 'nak'];
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

      // Claude Code
      update(IDX.claude, { status: 'running' });
      const cc = await installClaudeCode();
      update(IDX.claude, { status: cc.ok ? 'done' : 'error', detail: cc.detail });

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

      setFinished(true);
    })();
  }, [retryCount]);

  const compiling = steps.slice(IDX.relay, IDX.nak + 1).some(s => s.status === 'running');
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
