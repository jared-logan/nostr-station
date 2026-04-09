import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useInput } from 'ink';
import { P } from '../onboard/components/palette.js';
import { execSync, spawn } from 'child_process';
import os from 'os';

interface TuiProps {}

interface RelayEvent {
  id: string;
  kind: number;
  created_at: number;
  content: string;
  pubkey: string;
}

function isRelayUp(): boolean {
  try { execSync('nc -z localhost 8080', { stdio: 'pipe' }); return true; }
  catch { return false; }
}

function getMeshIp(): string {
  try {
    const out = execSync('nvpn status --json', { stdio: 'pipe' }).toString();
    return JSON.parse(out)?.tunnel_ip ?? '—';
  } catch { return '—'; }
}

function shortKey(pubkey: string): string {
  return pubkey ? `${pubkey.slice(0, 8)}…` : '?';
}

export const Tui: React.FC<TuiProps> = () => {
  const [events, setEvents] = useState<RelayEvent[]>([]);
  const [relayUp, setRelayUp] = useState(false);
  const [meshIp, setMeshIp] = useState('…');
  const [watchdogLine, setWatchdogLine] = useState('');
  const [tab, setTab] = useState<'events' | 'logs'>('events');
  const [logLines, setLogLines] = useState<string[]>([]);
  const nakRef = useRef<ReturnType<typeof spawn> | null>(null);

  // Poll status every 10s
  useEffect(() => {
    const poll = () => {
      setRelayUp(isRelayUp());
      setMeshIp(getMeshIp());
    };
    poll();
    const t = setInterval(poll, 10_000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to local relay for live events via nak
  useEffect(() => {
    if (!isRelayUp()) return;

    const nak = spawn('nak', ['req', '-k', '1', 'ws://localhost:8080'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nakRef.current = nak;

    nak.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const ev: RelayEvent = JSON.parse(line);
          setEvents(prev => [ev, ...prev].slice(0, 50));
        } catch {}
      }
    });

    return () => { nak.kill(); };
  }, [relayUp]);

  // Tail relay log
  useEffect(() => {
    const logFile = `${os.homedir()}/logs/nostr-rs-relay.log`;
    const tail = spawn('tail', ['-f', '-n', '20', logFile], { stdio: ['ignore', 'pipe', 'pipe'] });

    tail.stdout.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      setLogLines(prev => [...prev, ...lines].slice(-100));
      // Surface watchdog status
      const wd = lines.find(l => /watchdog|relay/i.test(l));
      if (wd) setWatchdogLine(wd.slice(0, 60));
    });

    return () => { tail.kill(); };
  }, []);

  // Keyboard nav
  useInput((input, key) => {
    if (input === 'e') setTab('events');
    if (input === 'l') setTab('logs');
    if (input === 'q' || (key.ctrl && input === 'c')) process.exit(0);
  });

  const kindLabel = (k: number) => {
    const kinds: Record<number, string> = { 1: 'note', 0: 'profile', 3: 'contacts', 4: 'DM', 6: 'repost', 7: 'reaction' };
    return kinds[k] ?? `kind:${k}`;
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Header bar */}
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station </Text>
        <Text color={P.accentDim}>tui  </Text>
        <Text color={relayUp ? P.success : P.error}>
          {relayUp ? '● relay up' : '○ relay down'}
        </Text>
        <Text color={P.muted}>{'  mesh: '}</Text>
        <Text>{meshIp}</Text>
        <Text color={P.muted}>{'  [e]vents  [l]ogs  [q]uit'}</Text>
      </Box>

      <Text color={P.accentDim}>{'─────────────────────────────────────────────'}</Text>

      {/* Events tab */}
      {tab === 'events' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={P.accentBright} bold>Live events  </Text>
            <Text color={P.muted}>ws://localhost:8080</Text>
          </Box>
          {events.length === 0 && (
            <Text color={P.muted}>Waiting for events… publish one with:</Text>
          )}
          {events.length === 0 && (
            <Text color={P.muted}>  nak event -k 1 --sec {'<nsec>'} "hello" ws://localhost:8080</Text>
          )}
          {events.map((ev, i) => (
            <Box key={i}>
              <Box width={10}>
                <Text color={P.accentDim}>{kindLabel(ev.kind)}</Text>
              </Box>
              <Box width={12}>
                <Text color={P.muted}>{shortKey(ev.pubkey)}</Text>
              </Box>
              <Text>
                {ev.content.slice(0, 60)}{ev.content.length > 60 ? '…' : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Logs tab */}
      {tab === 'logs' && (
        <Box flexDirection="column">
          <Box marginBottom={1}>
            <Text color={P.accentBright} bold>Relay log  </Text>
            <Text color={P.muted}>~/logs/nostr-rs-relay.log</Text>
          </Box>
          {logLines.slice(-20).map((line, i) => (
            <Text
              key={i}
              color={/error|ERR/i.test(line) ? P.error : /OK|start|listen/i.test(line) ? P.success : 'white'}
            >
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Text color={P.accentDim}>{'─────────────────────────────────────────────'}</Text>
      {watchdogLine && <Text color={P.muted}>watchdog: {watchdogLine}</Text>}
    </Box>
  );
};
