import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { P } from '../onboard/components/palette.js';
import {
  readRelaySettings, addToWhitelist, removeFromWhitelist,
  setAuthFlag, hexToNpub, defaultConfigPath,
} from '../lib/relay-config.js';
import { execSync } from 'child_process';
import os from 'os';

// ── Shared ─────────────────────────────────────────────────────────────────────

function restartRelay() {
  const isMac = process.platform === 'darwin';
  try {
    if (isMac) {
      execSync('launchctl stop com.nostr-station.relay 2>/dev/null; launchctl start com.nostr-station.relay', { stdio: 'pipe' });
    } else {
      execSync('systemctl --user restart nostr-relay.service', { stdio: 'pipe' });
    }
  } catch {}
}

const HR = () => (
  <Box><Text color={P.muted}>{'─'.repeat(45)}</Text></Box>
);

const Row = ({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) => (
  <Box>
    <Box width={14}><Text color={P.muted}>{label}</Text></Box>
    <Text color={(valueColor as any) ?? undefined}>{value}</Text>
  </Box>
);

// ── relay config ───────────────────────────────────────────────────────────────

interface RelayConfigViewProps {
  authToggle?: boolean;
  dmAuthToggle?: boolean;
}

type ConfigPhase = 'loading' | 'view' | 'confirm' | 'applying' | 'done' | 'error';

export const RelayConfigView: React.FC<RelayConfigViewProps> = ({ authToggle, dmAuthToggle }) => {
  const [phase, setPhase]     = useState<ConfigPhase>('loading');
  const [settings, setSettings] = useState<ReturnType<typeof readRelaySettings>>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [resultMsg, setResultMsg] = useState('');

  const configPath = defaultConfigPath();
  const homeDir    = os.homedir();

  useEffect(() => {
    const s = readRelaySettings();
    if (!s) {
      setErrorMsg(`Config not found: ${configPath}\nRun nostr-station onboard first.`);
      setPhase('error');
      return;
    }
    setSettings(s);

    if (!authToggle && !dmAuthToggle) {
      setPhase('view');
    } else {
      setPhase('confirm');
    }
  }, []);

  // Non-zero exit for error paths so scripts composing nostr-station
  // commands (`... relay config --auth on && ... relay restart`) can
  // tell the difference between "config updated" and "config not found".
  useEffect(() => {
    if (phase === 'error') process.exitCode = 1;
    if (phase === 'done' && resultMsg.startsWith('✗')) process.exitCode = 1;
  }, [phase, resultMsg]);

  // isActive gates Ink's raw-mode setup — critical so `relay config` in
  // view-only mode (no --auth/--dm-auth flags) doesn't crash on non-TTY
  // stdin. Without it, useInput's effect calls setRawMode(true) on mount
  // unconditionally, which throws on piped input even though we never
  // actually handle a keystroke in view mode.
  useInput((input, key) => {
    const answer = input.toLowerCase();
    if (key.return || answer === 'y') applyToggle();
    else if (answer === 'n' || key.escape) process.exit(0);
  }, { isActive: phase === 'confirm' });

  function applyToggle() {
    setPhase('applying');
    let ok = false;
    if (authToggle !== undefined) {
      ok = setAuthFlag('nip42_auth', authToggle);
    } else if (dmAuthToggle !== undefined) {
      ok = setAuthFlag('nip42_dms', dmAuthToggle);
    }
    if (ok) restartRelay();
    setResultMsg(ok ? '✓ Config updated — relay restarted' : '✗ Config update failed — check relay config file');
    setPhase('done');
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay config</Text></Box>
        <Text color={P.error}>{errorMsg}</Text>
      </Box>
    );
  }

  if (phase === 'loading') {
    return <Box paddingX={1}><Text color={P.muted}>Reading config…</Text></Box>;
  }

  const s = settings!;
  const flagName = authToggle !== undefined ? 'NIP-42 auth' : 'DM auth';
  const flagKey  = authToggle !== undefined ? 'nip42_auth' : 'nip42_dms';
  const flagVal  = authToggle ?? dmAuthToggle ?? false;
  const displayDataDir = s.dataDir.replace(os.homedir(), '~');
  const displayConfig  = configPath.replace(os.homedir(), '~');

  if (phase === 'view') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay config</Text></Box>
        <Text color={P.muted}>Relay configuration</Text>
        <HR />
        <Row label="Name"      value={s.name} />
        <Row label="URL"       value={s.url} />
        <Row label="Auth"      value={s.auth    ? 'NIP-42 enabled'  : 'disabled'} valueColor={s.auth    ? P.success : P.warn} />
        <Row label="DM auth"   value={s.dmAuth  ? 'enabled (kind 4, 44, 1059 require auth)' : 'disabled'} valueColor={s.dmAuth  ? P.success : P.warn} />
        <Row label="Whitelist" value={`${s.whitelist.length} npub${s.whitelist.length !== 1 ? 's' : ''}`} />
        {s.dataDir && <Row label="Data"   value={displayDataDir} />}
        <Row label="Config"    value={displayConfig} />
        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>Run <Text color={P.accentBright}>nostr-station relay whitelist</Text> to see whitelisted npubs.</Text>
          <Text color={P.muted}>Run <Text color={P.accentBright}>nostr-station relay restart</Text> to apply manual config changes.</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'confirm') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay config</Text></Box>
        <Text>Set <Text bold>{flagName}</Text> (<Text color={P.muted}>{flagKey}</Text>) to <Text bold color={flagVal ? P.success : P.warn}>{String(flagVal)}</Text>?</Text>
        <Text color={P.muted}>Relay will restart automatically. [y/N] </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay config</Text></Box>
      <Text color={phase === 'done' && resultMsg.startsWith('✓') ? P.success : P.error}>{resultMsg}</Text>
    </Box>
  );
};

// ── relay whitelist ────────────────────────────────────────────────────────────

interface RelayWhitelistProps {
  add?:    string;
  remove?: string;
}

type WlPhase = 'loading' | 'list' | 'confirm-remove' | 'working' | 'done' | 'error';

export const RelayWhitelist: React.FC<RelayWhitelistProps> = ({ add, remove }) => {
  const [phase, setPhase]       = useState<WlPhase>('loading');
  const [settings, setSettings] = useState<ReturnType<typeof readRelaySettings>>(null);
  const [resultMsg, setResultMsg] = useState('');
  const [resultOk, setResultOk] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const s = readRelaySettings();
    if (!s) {
      setErrorMsg(`Config not found: ${defaultConfigPath()}\nRun nostr-station onboard first.`);
      setPhase('error');
      return;
    }
    setSettings(s);

    if (add) {
      // Execute immediately — add has no confirmation prompt
      const res = addToWhitelist(add);
      if (!res.ok) {
        setErrorMsg(res.hex ? `Could not resolve npub to hex key. Is nak installed?` : `Invalid npub: ${add}`);
        setPhase('error');
        return;
      }
      setResultOk(true);
      setResultMsg(res.already
        ? `${add} is already whitelisted.`
        : `✓ Added to whitelist. Restart relay to apply: nostr-station relay restart`);
      setPhase('done');
    } else if (remove) {
      setPhase('confirm-remove');
    } else {
      setPhase('list');
    }
  }, []);

  // Non-zero exit for add failures and error phases — see note above.
  useEffect(() => {
    if (phase === 'error') process.exitCode = 1;
    if (phase === 'done' && !resultOk) process.exitCode = 1;
  }, [phase, resultOk]);

  // isActive gates raw-mode setup — `relay whitelist` (list mode) and
  // `relay whitelist --add <npub>` must not try to grab stdin. Only the
  // --remove path actually prompts for confirmation.
  useInput((input, key) => {
    const answer = input.toLowerCase();
    if (key.return || answer === 'y') executeRemove();
    else if (answer === 'n' || key.escape) process.exit(0);
  }, { isActive: phase === 'confirm-remove' });

  function executeRemove() {
    setPhase('working');
    const res = removeFromWhitelist(remove!);
    setResultOk(res.ok);
    setResultMsg(res.ok
      ? `✓ Removed. Restart relay to apply: nostr-station relay restart`
      : `✗ Failed to remove. Is nak installed and is the npub valid?`);
    setPhase('done');
  }

  if (phase === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay whitelist</Text></Box>
        <Text color={P.error}>{errorMsg}</Text>
      </Box>
    );
  }

  if (phase === 'loading') {
    return <Box paddingX={1}><Text color={P.muted}>Reading config…</Text></Box>;
  }

  if (phase === 'list') {
    const s = settings!;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay whitelist</Text></Box>
        {s.whitelist.length === 0 ? (
          <Text color={P.warn}>No npubs whitelisted — nobody can publish to your relay.</Text>
        ) : (
          <>
            <Text color={P.muted}>Whitelisted npubs ({s.whitelist.length})</Text>
            <HR />
            {s.whitelist.map((hex, i) => {
              const npub = hexToNpub(hex);
              return (
                <Box key={i} marginLeft={2}>
                  <Text color={P.accentDim}>• </Text>
                  <Text>{npub !== hex ? npub : hex}</Text>
                </Box>
              );
            })}
          </>
        )}
        <Box marginTop={1}>
          <Text color={P.muted}>Add: </Text>
          <Text color={P.accentBright}>nostr-station relay whitelist --add {'<npub>'}</Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'confirm-remove') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay whitelist</Text></Box>
        <Text>Remove <Text bold>{remove}</Text> from whitelist?</Text>
        <Box marginTop={1}>
          <Text color={P.warn}>⚠  This npub will no longer be able to publish to your relay.</Text>
        </Box>
        <Box marginTop={1}><Text color={P.muted}>Continue? [y/N] </Text></Box>
      </Box>
    );
  }

  // done / working
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}><Text color={P.accent} bold>nostr-station relay whitelist</Text></Box>
      {phase === 'working' ? (
        <Text color={P.muted}>Working…</Text>
      ) : (
        <Text color={resultOk ? P.success : P.error}>{resultMsg}</Text>
      )}
    </Box>
  );
};
