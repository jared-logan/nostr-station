import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { execa } from 'execa';
import { P } from '../onboard/components/palette.js';
import { Select } from '../onboard/components/Select.js';

interface SeedProps {
  eventCount: number;
  full: boolean;
}

const RELAY_URL = 'ws://localhost:8080';

const NOTE_CONTENT = [
  'Testing the local relay — hello nostr!',
  'Building something cool on Nostr. Stay tuned.',
  'The future of social media is protocol, not platform.',
  'nostr-rs-relay running locally. NIP-42 auth enabled.',
  'Just seeding the dev relay for testing. Ignore me.',
  'Decentralized identity is the killer app.',
  'Running my own relay feels good.',
  'Nostr dev environment up and running.',
  'Testing feeds, profiles, and reactions with dummy data.',
  'This is a test note from nostr-station seed command.',
];

function randomContent(i: number): string {
  return NOTE_CONTENT[i % NOTE_CONTENT.length] + ` (#${i + 1})`;
}

async function nakPublish(args: string[]): Promise<boolean> {
  try {
    await execa('nak', args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function relayEventCount(): Promise<number> {
  try {
    // nak req -l 1 just to check connectivity; count is hard to get cleanly
    // We use nak count if available, otherwise fall back to 0
    const { stdout } = await execa('nak', ['count', RELAY_URL], { stdio: 'pipe', timeout: 3000 });
    const n = parseInt(stdout.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

async function generateSeedKeypair(): Promise<{ nsec: string; npub: string }> {
  try {
    const { stdout } = await execa('nak', ['keygen'], { stdio: 'pipe' });
    const nsec = stdout.match(/nsec[a-z0-9]+/)?.[0] ?? '';
    const npub = stdout.match(/npub[a-z0-9]+/)?.[0] ?? '';
    return { nsec, npub };
  } catch {
    return { nsec: '', npub: '' };
  }
}

export const Seed: React.FC<SeedProps> = ({ eventCount, full }) => {
  const [phase, setPhase] = useState<'checking' | 'confirm' | 'seeding' | 'done' | 'error'>('checking');
  const [existingCount, setExistingCount] = useState(0);
  const [published, setPublished] = useState(0);
  const [total, setTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    (async () => {
      const count = await relayEventCount();
      setExistingCount(count);
      setPhase('confirm');
    })();
  }, []);

  // Auto-start when relay is empty — no need to confirm
  useEffect(() => {
    if (phase === 'confirm' && existingCount === 0) {
      runSeed();
    }
  }, [phase, existingCount]);

  // Propagate error phase as non-zero exit — runSeed hits 'error' when
  // nak is missing or the keypair can't be generated, and users running
  // `nostr-station seed && nostr-station tui` need that failure to stop
  // the chain.
  useEffect(() => {
    if (phase === 'error') process.exitCode = 1;
  }, [phase]);

  // Non-TTY safety: the <Select> confirmation prompt below uses useInput,
  // which needs raw-mode stdin and hard-crashes on piped/redirected input.
  // When we'd have to prompt but can't, abort with a clear stderr message
  // rather than letting Ink's error overlay eat the output. Dispatcher-level
  // gates can't handle this case — we don't know existingCount until we've
  // queried the running relay.
  useEffect(() => {
    if (phase !== 'confirm' || existingCount === 0) return;
    if (process.stdin.isTTY) return;
    process.stderr.write(
      `\nnostr-station seed: relay already has ${existingCount} event(s).\n`
      + `  Aborting — this command needs an interactive terminal to confirm\n`
      + `  that you want to add seed data on top of existing events.\n`
      + `  Run from a real terminal, or clear the relay first.\n\n`,
    );
    process.exit(1);
  }, [phase, existingCount]);

  const runSeed = async () => {
    const { nsec, npub } = await generateSeedKeypair();
    if (!nsec) {
      setErrorMsg('Could not generate keypair — is nak installed? (nostr-station doctor --fix)');
      setPhase('error');
      return;
    }

    const targetCount = eventCount;
    const fullTotal = full ? targetCount + 1 + 1 + Math.floor(targetCount / 3) : targetCount;
    setTotal(fullTotal);
    setPhase('seeding');

    let count = 0;

    // kind:0 profile (--full only)
    if (full) {
      const ok = await nakPublish([
        'event', '--sec', nsec,
        '-k', '0',
        '--content', JSON.stringify({
          name: 'seed-user',
          about: 'Seed account for nostr-station dev relay testing.',
          picture: '',
        }),
        RELAY_URL,
      ]);
      if (ok) { count++; setPublished(count); }
    }

    // kind:1 notes
    for (let i = 0; i < targetCount; i++) {
      const ok = await nakPublish([
        'event', '--sec', nsec,
        '-k', '1',
        '--content', randomContent(i),
        RELAY_URL,
      ]);
      if (ok) { count++; setPublished(count); }
    }

    // kind:3 contact list (--full only)
    if (full) {
      const ok = await nakPublish([
        'event', '--sec', nsec,
        '-k', '3',
        '--content', '{}',
        '-t', `p:${npub}`,
        RELAY_URL,
      ]);
      if (ok) { count++; setPublished(count); }
    }

    // kind:7 reactions on a sample of notes (--full only)
    if (full) {
      const reactionCount = Math.floor(targetCount / 3);
      for (let i = 0; i < reactionCount; i++) {
        const ok = await nakPublish([
          'event', '--sec', nsec,
          '-k', '7',
          '--content', '+',
          RELAY_URL,
        ]);
        if (ok) { count++; setPublished(count); }
      }
    }

    setPublished(count);
    setPhase('done');
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station seed</Text>
        {full && <Text color={P.muted}> --full</Text>}
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {phase === 'checking' && (
        <Text color={P.muted}>Checking relay…</Text>
      )}

      {phase === 'confirm' && existingCount > 0 && (
        <Select
          label={`Relay already has ${existingCount} event(s). Add seed data anyway?`}
          options={[
            { label: 'Yes, add seed data', value: 'yes' },
            { label: 'No, cancel',         value: 'no'  },
          ]}
          onSelect={item => {
            if (item.value === 'yes') runSeed();
            else process.exit(0);
          }}
        />
      )}

      {/* auto-start handled by useEffect above when existingCount === 0 */}

      {phase === 'seeding' && (
        <Box flexDirection="column">
          <Text color={P.muted}>
            Publishing events to {RELAY_URL}…
          </Text>
          <Box marginTop={1}>
            <Text color={P.accentBright}>{published}</Text>
            <Text color={P.muted}> / {total} events</Text>
          </Box>
          <Box marginTop={1}>
            <Text color={P.muted}>Using throwaway keypair — safe to discard after testing.</Text>
          </Box>
        </Box>
      )}

      {phase === 'done' && (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.success}>✓ Seeded relay with {published} events</Text>
          <Box marginTop={1}>
            <Text color={P.muted}>Verify: </Text>
            <Text>nak req -k 1 -l 5 {RELAY_URL}</Text>
          </Box>
        </Box>
      )}

      {phase === 'error' && (
        <Text color={P.warn}>✗ {errorMsg}</Text>
      )}
    </Box>
  );
};
