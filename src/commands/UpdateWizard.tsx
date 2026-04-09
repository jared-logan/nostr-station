import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { Select, type SelectOption } from '../onboard/components/Select.js';
import { P } from '../onboard/components/palette.js';
import { execa } from 'execa';

interface UpdateWizardProps {}

interface ComponentInfo {
  name: string;
  current: string;
  latest?: string;
  updateAvailable: boolean;
}

type Stage = 'checking' | 'confirm' | 'updating' | 'done';

async function getCargoVersion(bin: string): Promise<string> {
  try {
    const { stdout } = await execa(bin, ['--version'], { stdio: 'pipe' });
    return stdout.trim().split(/\s+/).pop() ?? '?';
  } catch { return 'not installed'; }
}

async function getNpmVersion(pkg: string): Promise<{ current: string; latest: string }> {
  try {
    const cur = await execa('npm', ['list', '-g', '--json', pkg], { stdio: 'pipe' });
    const lat = await execa('npm', ['view', pkg, 'version'], { stdio: 'pipe' });
    const curData = JSON.parse(cur.stdout);
    const current = Object.values(curData.dependencies ?? {})[0] as any;
    return {
      current: current?.version ?? '?',
      latest: lat.stdout.trim(),
    };
  } catch { return { current: '?', latest: '?' }; }
}

export const UpdateWizard: React.FC<UpdateWizardProps> = () => {
  const [stage, setStage] = useState<Stage>('checking');
  const [components, setComponents] = useState<ComponentInfo[]>([]);
  const [updateSteps, setUpdateSteps] = useState<{ label: string; status: StepStatus; detail?: string }[]>([]);

  // Check all versions
  useEffect(() => {
    (async () => {
      const relay = await getCargoVersion('nostr-rs-relay');
      const ngit  = await getCargoVersion('ngit');
      const nak   = await getCargoVersion('nak');
      const cc    = await getNpmVersion('@anthropic-ai/claude-code');

      setComponents([
        { name: 'nostr-rs-relay', current: relay,      latest: undefined, updateAvailable: true },
        { name: 'ngit',           current: ngit,       latest: undefined, updateAvailable: true },
        { name: 'nak',            current: nak,        latest: undefined, updateAvailable: true },
        { name: 'claude-code',    current: cc.current, latest: cc.latest, updateAvailable: cc.current !== cc.latest },
      ]);
      setStage('confirm');
    })();
  }, []);

  const handleChoice = (item: SelectOption) => {
    if (item.value === 'cancel') { process.exit(0); }
    runUpdates();
  };

  const runUpdates = async () => {
    const steps = components.map(c => ({ label: c.name, status: 'pending' as StepStatus }));
    setUpdateSteps(steps);
    setStage('updating');

    const up = (i: number, patch: Partial<typeof steps[0]>) =>
      setUpdateSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

    // Cargo bins
    for (let i = 0; i < 3; i++) {
      const pkg = components[i].name;
      up(i, { status: 'running', detail: 'compiling…' });
      const start = Date.now();

      const ticker = setInterval(() => {
        const s = Math.floor((Date.now() - start) / 1000);
        up(i, { detail: `compiling… ${s}s` });
      }, 5000);

      try {
        const proc = execa('cargo', ['install', pkg, '--locked'], { stdio: 'pipe' });
        proc.stderr?.on('data', (chunk: Buffer) => {
          const line = chunk.toString().trim().split('\n').pop() ?? '';
          if (line) up(i, { detail: line.slice(0, 55) });
        });
        await proc;
        clearInterval(ticker);
        up(i, { status: 'done', detail: `${Math.floor((Date.now() - start) / 1000)}s` });
      } catch {
        clearInterval(ticker);
        up(i, { status: 'error' });
      }
    }

    // npm
    up(3, { status: 'running' });
    try {
      await execa('npm', ['update', '-g', '@anthropic-ai/claude-code', '--quiet'], { stdio: 'pipe' });
      up(3, { status: 'done' });
    } catch {
      up(3, { status: 'error' });
    }

    setStage('done');
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station update wizard</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {stage === 'checking' && (
        <Text color={P.muted}>Checking installed versions…</Text>
      )}

      {stage === 'confirm' && (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            {components.map((c, i) => (
              <Box key={i}>
                <Box width={18}><Text>{c.name}</Text></Box>
                <Text color={P.muted}>{c.current}</Text>
                {c.latest && c.latest !== c.current && (
                  <Text color={P.success}>{`  → ${c.latest}`}</Text>
                )}
                {c.latest && c.latest === c.current && (
                  <Text color={P.muted}>  up to date</Text>
                )}
                {!c.latest && (
                  <Text color={P.muted}>  will reinstall latest</Text>
                )}
              </Box>
            ))}
          </Box>

          <Select
            label="Proceed with update?"
            options={[
              { label: 'Update all', value: 'all' },
              { label: 'Cancel',     value: 'cancel' },
            ]}
            onSelect={handleChoice}
          />
        </Box>
      )}

      {(stage === 'updating' || stage === 'done') && (
        <Box flexDirection="column">
          {updateSteps.map((s, i) => (
            <Step key={i} label={s.label} status={s.status} detail={s.detail} />
          ))}
          {stage === 'done' && (
            <Box marginTop={1}>
              <Text color={P.success}>✓ Update complete</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
