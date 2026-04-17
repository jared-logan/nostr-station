import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Select } from '../onboard/components/Select.js';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';

interface UninstallProps { yes: boolean; }

type Stage = 'confirm' | 'running' | 'done';

const HOME = os.homedir();
const IS_MAC = process.platform === 'darwin';

// Everything nostr-station owns — nothing else
const WHAT_GETS_REMOVED = [
  'nostr-rs-relay service',
  'watchdog service',
  'relay config (~/.config/nostr-rs-relay/)',
  'log files (~/logs/nostr-rs-relay*, ~/logs/watchdog*)',
  'watchdog script (~/scripts/relay-watchdog.sh)',
  'stored secrets (system keychain: service=nostr-station)',
  'npm global: nostr-station',
];

const WHAT_STAYS = [
  'nostr-vpn (installed separately)',
  'ngit config and repos',
  'claude-code',
  'nak',
  'Rust/cargo',
  'Your relay data (SQLite)',
];

function shell(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

export const Uninstall: React.FC<UninstallProps> = ({ yes }) => {
  const [stage, setStage] = useState<Stage>(yes ? 'running' : 'confirm');
  const [steps, setSteps] = useState<{ label: string; status: StepStatus }[]>([]);

  const up = (i: number, status: StepStatus) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, status } : s));

  const run = async () => {
    const initial = [
      { label: 'Stop relay service',     status: 'pending' as StepStatus },
      { label: 'Stop watchdog service',  status: 'pending' as StepStatus },
      { label: 'Remove service files',   status: 'pending' as StepStatus },
      { label: 'Remove relay config',    status: 'pending' as StepStatus },
      { label: 'Remove log files',       status: 'pending' as StepStatus },
      { label: 'Remove watchdog script', status: 'pending' as StepStatus },
      { label: 'Clear stored secrets',   status: 'pending' as StepStatus },
      { label: 'Uninstall npm package',  status: 'pending' as StepStatus },
    ];
    setSteps(initial);
    setStage('running');

    // Stop services
    up(0, 'running');
    if (IS_MAC) {
      shell('launchctl stop com.nostr-station.relay 2>/dev/null');
      shell(`launchctl unload "${HOME}/Library/LaunchAgents/com.nostr-station.relay.plist" 2>/dev/null`);
    } else {
      shell('systemctl --user stop nostr-relay.service 2>/dev/null');
      shell('systemctl --user disable nostr-relay.service 2>/dev/null');
    }
    up(0, 'done');

    up(1, 'running');
    if (IS_MAC) {
      shell('launchctl stop com.nostr-station.watchdog 2>/dev/null');
      shell(`launchctl unload "${HOME}/Library/LaunchAgents/com.nostr-station.watchdog.plist" 2>/dev/null`);
    } else {
      shell('systemctl --user stop nostr-watchdog.timer 2>/dev/null');
      shell('systemctl --user disable nostr-watchdog.timer 2>/dev/null');
    }
    up(1, 'done');

    // Remove service files
    up(2, 'running');
    if (IS_MAC) {
      shell(`rm -f "${HOME}/Library/LaunchAgents/com.nostr-station.relay.plist"`);
      shell(`rm -f "${HOME}/Library/LaunchAgents/com.nostr-station.watchdog.plist"`);
    } else {
      shell(`rm -f "${HOME}/.config/systemd/user/nostr-relay.service"`);
      shell(`rm -f "${HOME}/.config/systemd/user/nostr-watchdog.service"`);
      shell(`rm -f "${HOME}/.config/systemd/user/nostr-watchdog.timer"`);
      shell('systemctl --user daemon-reload 2>/dev/null');
    }
    up(2, 'done');

    // Relay config
    up(3, 'running');
    shell(`rm -rf "${HOME}/.config/nostr-rs-relay"`);
    up(3, 'done');

    // Logs
    up(4, 'running');
    shell(`rm -f "${HOME}/logs/nostr-rs-relay.log" "${HOME}/logs/nostr-rs-relay.error.log"`);
    shell(`rm -f "${HOME}/logs/watchdog.log" "${HOME}/logs/watchdog.error.log"`);
    up(4, 'done');

    // Watchdog script
    up(5, 'running');
    shell(`rm -f "${HOME}/scripts/relay-watchdog.sh"`);
    up(5, 'done');

    // Stored secrets — wipe every slot keychain.ts wrote under
    // `service=nostr-station` (watchdog-nsec, demo-nsec, legacy
    // ai-api-key, and all ai:<provider-id> slots).
    //
    // Linux: `secret-tool clear` accepts an attribute filter and removes
    // every matching item in one call.
    //
    // macOS: `security delete-generic-password` has no wildcard — it
    // removes one match per invocation and exits non-zero when nothing is
    // left. We loop until it fails, capped at 64 iterations as a safety
    // net in case deletion ever appears to succeed without actually
    // removing the item (would otherwise spin forever).
    //
    // Encrypted-file fallback (Linux without libsecret-tools or DBus):
    // unconditionally rm the file — keychain.ts writes it as the single
    // JSON store `~/.config/nostr-station/secrets`. Safe to run even when
    // the real keyring was active; a missing file is a no-op.
    up(6, 'running');
    if (IS_MAC) {
      shell(
        'for i in $(seq 1 64); do ' +
        'security delete-generic-password -s nostr-station >/dev/null 2>&1 || break; ' +
        'done'
      );
    } else {
      shell('secret-tool clear service nostr-station 2>/dev/null');
      shell(`rm -f "${HOME}/.config/nostr-station/secrets"`);
    }
    up(6, 'done');

    // npm package
    up(7, 'running');
    shell('npm uninstall -g nostr-station --quiet');
    up(7, 'done');

    setStage('done');
  };

  useEffect(() => {
    if (yes) run();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.error} bold>nostr-station uninstall</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {stage === 'confirm' && (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text color={P.warn} bold>This will remove:</Text>
            {WHAT_GETS_REMOVED.map((w, i) => (
              <Text key={i} color={P.error}>  ✗ {w}</Text>
            ))}
          </Box>
          <Box marginBottom={1} flexDirection="column">
            <Text color={P.muted} bold>This stays:</Text>
            {WHAT_STAYS.map((w, i) => (
              <Text key={i} color={P.muted}>  ○ {w}</Text>
            ))}
          </Box>
          <Select
            label="Continue?"
            options={[
              { label: 'Cancel (keep everything)', value: 'cancel' },
              { label: 'Uninstall',                value: 'uninstall' },
            ]}
            onSelect={item => {
              if (item.value === 'cancel') process.exit(0);
              else run();
            }}
          />
        </Box>
      )}

      {(stage === 'running' || stage === 'done') && (
        <Box flexDirection="column">
          {steps.map((s, i) => (
            <Step key={i} label={s.label} status={s.status} />
          ))}
          {stage === 'done' && (
            <Box marginTop={1} flexDirection="column">
              <Text color={P.success}>✓ Removed</Text>
              <Text color={P.muted}>Your relay data and ngit repos are untouched.</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
};
