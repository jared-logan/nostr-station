import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { P } from '../onboard/components/palette.js';
import { execa } from 'execa';

interface UpdateProps { dryRun: boolean; yes: boolean; }

type S = { label: string; status: StepStatus; from?: string; to?: string; detail?: string };

const CARGO_BINS = ['nostr-rs-relay', 'ngit', 'nak'];
const NPM_GLOBALS = ['@anthropic-ai/claude-code'];

async function currentVersion(bin: string): Promise<string> {
  try {
    const { stdout } = await execa(bin, ['--version'], { stdio: 'pipe' });
    return stdout.trim().split(/\s+/).pop() ?? '?';
  } catch { return '?'; }
}

export const Update: React.FC<UpdateProps> = ({ dryRun, yes }) => {
  const [steps, setSteps] = useState<S[]>([
    { label: 'nostr-rs-relay', status: 'pending' },
    { label: 'ngit',           status: 'pending' },
    { label: 'nak',            status: 'pending' },
    { label: 'claude-code',    status: 'pending' },
  ]);
  const [done, setDone] = useState(false);

  const up = (i: number, patch: Partial<S>) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  useEffect(() => {
    (async () => {
      // Cargo bins
      for (let i = 0; i < CARGO_BINS.length; i++) {
        const pkg = CARGO_BINS[i];
        const before = await currentVersion(pkg);
        up(i, { status: 'running', from: before });

        if (!dryRun) {
          try {
            await execa('cargo', ['install', pkg, '--quiet'], { stdio: 'pipe' });
            const after = await currentVersion(pkg);
            up(i, { status: 'done', to: after });
          } catch (e: any) {
            up(i, { status: 'error', detail: e.message?.slice(0, 80) });
          }
        } else {
          up(i, { status: 'skip', detail: 'dry-run' });
        }
      }

      // npm globals
      for (let i = 0; i < NPM_GLOBALS.length; i++) {
        const pkg = NPM_GLOBALS[i];
        const idx = CARGO_BINS.length + i;
        up(idx, { status: 'running' });

        if (!dryRun) {
          try {
            await execa('npm', ['update', '-g', pkg, '--quiet'], { stdio: 'pipe' });
            up(idx, { status: 'done' });
          } catch (e: any) {
            up(idx, { status: 'error', detail: e.message?.slice(0, 80) });
          }
        } else {
          up(idx, { status: 'skip', detail: 'dry-run' });
        }
      }

      setDone(true);
    })();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station update</Text>
        {dryRun && <Text color={P.muted}> --dry-run</Text>}
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {steps.map((s, i) => (
        <Step
          key={i}
          label={s.label}
          status={s.status}
          detail={
            s.status === 'done' && s.from && s.to && s.from !== s.to
              ? `${s.from} → ${s.to}`
              : s.detail
          }
        />
      ))}

      {done && (
        <Box marginTop={1}>
          <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
        </Box>
      )}
      {done && !dryRun && (
        <Text color={P.success}>✓ Update complete</Text>
      )}
      {done && dryRun && (
        <Text color={P.muted}>Dry run — no changes made. Re-run without --dry-run to apply.</Text>
      )}
    </Box>
  );
};
