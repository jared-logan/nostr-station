import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { execa } from 'execa';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { P } from '../cli-ui/palette.js';
import { Select } from '../cli-ui/Select.js';
import { getKeychain } from '../lib/keychain.js';
// addToWhitelist + restartRelay are gone — the in-process relay has no
// NIP-42 auth or whitelist (yet), so seed publishes directly.

interface SeedProps {
  eventCount: number;
  full: boolean;
}

// In-process relay defaults; honors the env vars web-server.ts publishes
// when the dashboard is already running so a `seed --full` against a
// non-default port still hits the right relay.
const RELAY_HOST = process.env.RELAY_HOST || '127.0.0.1';
const RELAY_PORT = process.env.RELAY_PORT || '7777';
const RELAY_URL  = `ws://${RELAY_HOST}:${RELAY_PORT}`;

const NOTE_CONTENT = [
  'Testing the local relay — hello nostr!',
  'Building something cool on Nostr. Stay tuned.',
  'The future of social media is protocol, not platform.',
  'In-process relay running locally. NIP-42 auth enabled.',
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

// nak's `event` / `count` / `req` commands optionally read a partial event
// or query from stdin. With stdio:'pipe' and no stdin write, they block on
// EOF indefinitely — spent a while debugging a 0/50 progress bar before
// discovering that. Passing `stdin: 'ignore'` closes stdin immediately so
// nak skips the read and uses the --flag values directly. A 10s timeout
// caps any remaining edge cases (unresponsive relay, network stall).
//
// Rejection detection: nak writes the publish result to stdout/stderr and
// exits 0 even when the relay returns `["OK", id, false, "<reason>"]`
// ("blocked: pubkey is not allowed", "auth-required", etc.). Earlier
// versions of this helper trusted the exit code alone, and seed would
// cheerfully report "✓ Seeded 50 events" while the relay dropped every
// one. We now scan the combined output for the textual failure markers
// nak prints — "failed:", "NOTICE: blocked", "auth-required" — and treat
// a matching string as a non-success.
const NAK_REJECT_RE = /failed:|\bblocked\b|auth-required|restricted|rate-limit/i;

async function nakPublish(args: string[]): Promise<{ ok: boolean; reason?: string }> {
  try {
    const { stdout, stderr } = await execa('nak', args, {
      stdin: 'ignore', timeout: 10_000, reject: false,
    });
    const combined = `${stdout}\n${stderr}`;
    const match = combined.match(NAK_REJECT_RE);
    if (match) {
      // Try to extract the "msg: <reason>" tail nak prints so errors are
      // actionable ("blocked: pubkey is not allowed to publish") rather
      // than just "rejected". Falls back to the match itself.
      const msg = combined.match(/failed:\s*msg:\s*([^\n]+)/i)?.[1]
               ?? combined.match(/NOTICE:[^\n]+/i)?.[0]
               ?? match[0];
      return { ok: false, reason: msg.trim().slice(0, 160) };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: (e?.shortMessage || e?.message || 'exec failed').slice(0, 160) };
  }
}

async function relayEventCount(authNsec: string): Promise<number> {
  try {
    const { stdout } = await execa(
      'nak', ['count', '--auth', authNsec, RELAY_URL],
      { stdin: 'ignore', timeout: 3000 },
    );
    const n = parseInt(stdout.trim(), 10);
    return isNaN(n) ? 0 : n;
  } catch {
    return 0;
  }
}

// ── Seed identity ──────────────────────────────────────────────────────────
//
// Seed uses a single stable keypair stored in the OS keychain (slot
// `seed-nsec`). First run generates + stores; every subsequent run
// retrieves and reuses. The npub is auto-whitelisted on the local relay
// so NIP-42-gated publishing succeeds without the user having to
// `relay whitelist --add` by hand. One relay restart on first seed;
// zero on subsequent runs.
async function ensureSeedIdentity(): Promise<{ nsec: string; npub: string; freshlyGenerated: boolean }> {
  const kc = getKeychain();
  const existing = await kc.retrieve('seed-nsec');
  if (existing && existing.startsWith('nsec')) {
    try {
      const d = nip19.decode(existing);
      if (d.type === 'nsec') {
        const pk = getPublicKey(d.data as Uint8Array);
        return {
          nsec: existing,
          npub: nip19.npubEncode(pk),
          freshlyGenerated: false,
        };
      }
    } catch { /* malformed — fall through and regenerate */ }
  }
  const sk = generateSecretKey();
  const nsec = nip19.nsecEncode(sk);
  const npub = nip19.npubEncode(getPublicKey(sk));
  await kc.store('seed-nsec', nsec);
  return { nsec, npub, freshlyGenerated: true };
}

export const Seed: React.FC<SeedProps> = ({ eventCount, full }) => {
  const [phase, setPhase] = useState<
    'preparing' | 'checking' | 'confirm' | 'seeding' | 'done' | 'error'
  >('preparing');
  const [prepareStatus, setPrepareStatus] = useState('Looking up seed identity…');
  const [existingCount, setExistingCount] = useState(0);
  const [published, setPublished] = useState(0);
  const [failed, setFailed] = useState(0);
  const [firstFailReason, setFirstFailReason] = useState('');
  const [total, setTotal] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [seedNsec, setSeedNsec] = useState('');
  const [seedNpub, setSeedNpub] = useState('');

  useEffect(() => {
    (async () => {
      // 1. Ensure the seed identity exists (retrieve or generate+store).
      let ident;
      try {
        ident = await ensureSeedIdentity();
      } catch (e: any) {
        setErrorMsg(`Could not set up seed identity: ${e?.message ?? 'unknown'}`);
        setPhase('error');
        return;
      }
      setSeedNsec(ident.nsec);
      setSeedNpub(ident.npub);

      // (whitelist + relay restart removed — the in-process relay accepts
      // any signed event from any pubkey. NIP-42 is a future hardening pass.)

      // 2. Now that we can reach the relay with an authenticated,
      // whitelisted identity, see how many events it already has — the
      // confirm prompt depends on this count.
      setPrepareStatus('Counting existing events…');
      const count = await relayEventCount(ident.nsec);
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
  // the seed identity can't be set up or the relay won't restart. Also
  // exit non-zero if seeding "completed" but the relay rejected every
  // event: users running `nostr-station seed && nostr-station tui` need
  // that failure to stop the chain instead of being misled by the
  // Ink-only warn row.
  useEffect(() => {
    if (phase === 'error') process.exitCode = 1;
    if (phase === 'done' && published === 0 && failed > 0) process.exitCode = 1;
  }, [phase, published, failed]);

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
    const nsec = seedNsec;
    const npub = seedNpub;
    if (!nsec || !npub) {
      setErrorMsg('Seed identity not initialized — this is a bug. Please re-run.');
      setPhase('error');
      return;
    }

    const targetCount = eventCount;
    const fullTotal = full ? targetCount + 1 + 1 + Math.floor(targetCount / 3) : targetCount;
    setTotal(fullTotal);
    setPhase('seeding');

    let count = 0;
    let fails = 0;
    const recordResult = (r: { ok: boolean; reason?: string }) => {
      if (r.ok) { count++; setPublished(count); }
      else      { fails++; setFailed(fails); if (fails === 1 && r.reason) setFirstFailReason(r.reason); }
    };

    // Every call passes both --sec (to sign the event) AND --auth (to
    // answer the relay's NIP-42 AUTH challenge with the same key). These
    // are the two halves the previous version was missing — no --auth
    // meant the relay dropped the publish with "auth-required", and
    // signing with a non-whitelisted key would have been rejected even
    // after auth. With the seed npub now whitelisted (prepare phase) and
    // --auth present, publishes actually land.

    // kind:0 profile (--full only)
    if (full) {
      recordResult(await nakPublish([
        'event', '--sec', nsec, '--auth', nsec,
        '-k', '0',
        '--content', JSON.stringify({
          name: 'seed-user',
          about: 'Seed account for nostr-station dev relay testing.',
          picture: '',
        }),
        RELAY_URL,
      ]));
    }

    // kind:1 notes
    for (let i = 0; i < targetCount; i++) {
      recordResult(await nakPublish([
        'event', '--sec', nsec, '--auth', nsec,
        '-k', '1',
        '--content', randomContent(i),
        RELAY_URL,
      ]));
    }

    // kind:3 contact list (--full only)
    if (full) {
      recordResult(await nakPublish([
        'event', '--sec', nsec, '--auth', nsec,
        '-k', '3',
        '--content', '{}',
        '-t', `p:${npub}`,
        RELAY_URL,
      ]));
    }

    // kind:7 reactions on a sample of notes (--full only)
    if (full) {
      const reactionCount = Math.floor(targetCount / 3);
      for (let i = 0; i < reactionCount; i++) {
        recordResult(await nakPublish([
          'event', '--sec', nsec, '--auth', nsec,
          '-k', '7',
          '--content', '+',
          RELAY_URL,
        ]));
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

      {phase === 'preparing' && (
        <Text color={P.muted}>{prepareStatus}</Text>
      )}

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
          {failed === 0 ? (
            <Text color={P.success}>✓ Seeded relay with {published} events</Text>
          ) : published > 0 ? (
            <Text color={P.warn}>⚠ Published {published}/{total} events — {failed} rejected</Text>
          ) : (
            <Text color={P.error}>✗ All {total} events rejected by the relay</Text>
          )}
          {firstFailReason && (
            <Box marginTop={1}>
              <Text color={P.muted}>Reason: </Text>
              <Text color={P.warn}>{firstFailReason}</Text>
            </Box>
          )}
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
