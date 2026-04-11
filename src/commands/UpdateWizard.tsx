import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { Select, type SelectOption } from '../onboard/components/Select.js';
import { P } from '../onboard/components/palette.js';
import { execa } from 'execa';
import { COMPONENT_VERSIONS } from '../lib/versions.js';
import { installNak } from '../lib/install.js';
import { detectPlatform } from '../lib/detect.js';

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
        {
          name: 'nostr-rs-relay',
          current: relay,
          latest: COMPONENT_VERSIONS['nostr-rs-relay'],
          updateAvailable: relay !== COMPONENT_VERSIONS['nostr-rs-relay'],
        },
        {
          name: 'ngit',
          current: ngit,
          latest: COMPONENT_VERSIONS['ngit'],
          updateAvailable: ngit !== COMPONENT_VERSIONS['ngit'],
        },
        {
          name: 'nak',
          current: nak,
          latest: COMPONENT_VERSIONS['nak'],
          updateAvailable: nak !== COMPONENT_VERSIONS['nak'],
        },
        { name: 'claude-code', current: cc.current, latest: cc.latest, updateAvailable: cc.current !== cc.latest },
      ]);
      setStage('confirm');
    })();
  }, []);

  const handleChoice = (item: SelectOption) => {
    if (item.value === 'cancel') { process.exit(0); }
    runUpdates();
  };

  const runUpdates = async () => {
    const steps: { label: string; status: StepStatus; detail?: string }[] =
      components.map(c => ({ label: c.name, status: 'pending' as StepStatus }));
    setUpdateSteps(steps);
    setStage('updating');

    const up = (i: number, patch: Partial<typeof steps[0]>) =>
      setUpdateSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

    // Only the first two slots (relay, ngit) are cargo installs.
    // Slot 2 is nak (Go binary, prebuilt), slot 3 is claude-code (npm global).
    // `components` preserves the order from the check phase above.
    const CARGO_SLOT_COUNT = 2;
    for (let i = 0; i < CARGO_SLOT_COUNT; i++) {
      const pkg = components[i].name;
      up(i, { status: 'running', detail: 'compiling…' });
      const start = Date.now();

      const ticker = setInterval(() => {
        const s = Math.floor((Date.now() - start) / 1000);
        up(i, { detail: `compiling… ${s}s` });
      }, 5000);

      try {
        // No --locked: older crates ship Cargo.lock entries that break on
        // modern rustc (e.g. time 0.3.25 → E0282). See lib/install.ts.
        const pinnedVersion = COMPONENT_VERSIONS[pkg as keyof typeof COMPONENT_VERSIONS];
      const cargoArgs = pinnedVersion
        ? ['install', pkg, '--version', pinnedVersion]
        : ['install', pkg];
      const proc = execa('cargo', cargoArgs, { stdio: 'pipe' });
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

    // nak — Go binary from fiatjaf/nak releases, NOT on crates.io.
    // Previously this wizard ran `cargo install nak` which failed 100% of
    // the time; funneling through installNak() reuses the GitHub-releases
    // download path already used by onboard's install phase.
    up(2, { status: 'running', detail: 'downloading…' });
    try {
      const platform = detectPlatform();
      const r = await installNak(platform.cargoBin);
      up(2, { status: r.ok ? 'done' : 'error', detail: r.detail?.slice(0, 55) });
    } catch (e: any) {
      up(2, { status: 'error', detail: e.message?.slice(0, 55) });
    }

    // npm — claude-code
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
