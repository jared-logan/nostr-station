import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Select } from '../onboard/components/Select.js';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { P } from '../onboard/components/palette.js';
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { probePidFile, removePidFile, pidFilePath } from '../lib/pid-file.js';

interface UninstallProps { yes: boolean; }

// 'pid-blocked' is a hard stop before any teardown runs — see PID-file
// section below. Once we're past it the wizard is the same shape as the
// pre-B3 version, with one new optional 'remove configs?' confirm
// inserted between the keychain step and the npm uninstall.
type Stage = 'confirm' | 'pid-blocked' | 'running' | 'config-prompt' | 'done';

const HOME = os.homedir();
const IS_MAC = process.platform === 'darwin';

// Configuration files that the optional "Remove configuration files?"
// step nukes when the user opts in. Default is to LEAVE these — most
// uninstalls are reinstalls, and rebuilding identity / projects / AI
// config from scratch is annoying. Listed here (not inlined below) so
// the confirm screen can show the user exactly what will go.
const CONFIG_FILES = [
  path.join(HOME, '.config', 'nostr-station', 'identity.json'),
  path.join(HOME, '.config', 'nostr-station', 'projects.json'),
  path.join(HOME, '.config', 'nostr-station', 'ai-config.json'),
  path.join(HOME, '.claude_env'),
  path.join(HOME, 'projects', 'NOSTR_STATION.md'),
];

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
  'nostr-station configs (identity, projects, ai-config) — opt-in to remove',
];

function shell(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

export const Uninstall: React.FC<UninstallProps> = ({ yes }) => {
  const [stage, setStage] = useState<Stage>('confirm');
  const [steps, setSteps] = useState<{ label: string; status: StepStatus }[]>([]);
  const [livePid, setLivePid] = useState<number | null>(null);

  const up = (i: number, status: StepStatus) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, status } : s));

  // Run steps 0–6 (the always-on teardown). Stops at the keychain step
  // and hands off to the config-prompt stage where the user opts in or
  // out of removing config files. Step 7 (npm uninstall) runs after the
  // prompt resolves.
  const runTeardown = async () => {
    const initial = [
      { label: 'Stop relay service',     status: 'pending' as StepStatus },
      { label: 'Stop watchdog service',  status: 'pending' as StepStatus },
      { label: 'Remove service files',   status: 'pending' as StepStatus },
      { label: 'Remove relay config',    status: 'pending' as StepStatus },
      { label: 'Remove log files',       status: 'pending' as StepStatus },
      { label: 'Remove watchdog script', status: 'pending' as StepStatus },
      { label: 'Clear stored secrets',   status: 'pending' as StepStatus },
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

    // Hand off to the config-prompt stage. With --yes we skip the prompt
    // and treat it as "no" (preserve configs for reinstall, the documented
    // default).
    if (yes) {
      finishUninstall(false);
    } else {
      setStage('config-prompt');
    }
  };

  // Final stage: optional config wipe + npm uninstall. Pulled out so both
  // the config-prompt branch (user-driven) and the --yes branch (auto)
  // share one path.
  const finishUninstall = async (removeConfigs: boolean) => {
    const tail: { label: string; status: StepStatus }[] = [];
    if (removeConfigs) {
      tail.push({ label: 'Remove nostr-station configs', status: 'pending' as StepStatus });
    }
    tail.push({ label: 'Uninstall npm package', status: 'pending' as StepStatus });

    setSteps(prev => [...prev, ...tail]);
    setStage('running');

    // Re-find the index of the first appended step so `up` lines up after
    // the steady-state 7-row teardown list.
    const TEARDOWN_LEN = 7;
    let idx = TEARDOWN_LEN;

    if (removeConfigs) {
      up(idx, 'running');
      for (const f of CONFIG_FILES) {
        try { fs.rmSync(f, { force: true }); } catch { /* best-effort */ }
      }
      up(idx, 'done');
      idx++;
    }

    up(idx, 'running');
    shell('npm uninstall -g nostr-station --quiet');
    up(idx, 'done');

    setStage('done');
  };

  // PID-file gate — runs once on mount. Three outcomes:
  //   1. No PID file (or stale): clear any stale file and continue to the
  //      normal confirm flow (or auto-run if --yes).
  //   2. Live PID: refuse with stage='pid-blocked'. The user has to stop
  //      the dashboard themselves; we won't kill it for them because that
  //      orphans terminal sessions, kills in-flight git pushes, etc.
  //   3. EPERM / unknown: defensively treat as alive (same UI as case 2).
  //      Better to surface "we can't tell, please stop it" than to nuke
  //      services out from under another user's running dashboard.
  useEffect(() => {
    const status = probePidFile();
    if (status.state === 'alive' || status.state === 'unknown') {
      setLivePid(status.pid);
      setStage('pid-blocked');
      return;
    }
    if (status.state === 'stale' || status.state === 'unreadable') {
      // Drop the orphan file before we proceed. ESRCH means the dashboard
      // crashed without firing its cleanup handlers; uninstall is exactly
      // the right moment to garbage-collect.
      removePidFile();
    }
    if (yes) runTeardown();
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.error} bold>nostr-station uninstall</Text>
      </Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      {stage === 'pid-blocked' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={P.error}>
            ✗ The dashboard is still running (pid {livePid}).
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={P.muted}>Stop it first, then re-run uninstall:</Text>
            <Text>{'  '}1. In the dashboard's terminal: press Ctrl+C</Text>
            <Text>{'  '}2. Or from any shell: kill {livePid}</Text>
            <Text color={P.muted}>{'  (pid file: '}{pidFilePath()}{')'}</Text>
          </Box>
        </Box>
      )}

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
              else runTeardown();
            }}
          />
        </Box>
      )}

      {stage === 'config-prompt' && (
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text color={P.warn} bold>Also remove configuration files?</Text>
            {CONFIG_FILES.map((f, i) => (
              <Text key={i} color={P.muted}>  • {f.replace(HOME, '~')}</Text>
            ))}
            <Box marginTop={1}>
              <Text color={P.muted}>
                Default: keep configs. Reinstalling later won't have to re-enter
                identity, projects, or AI provider keys.
              </Text>
            </Box>
          </Box>
          <Select
            label="Remove configs?"
            options={[
              { label: 'Keep configuration files (default)', value: 'no'  },
              { label: 'Remove them too',                    value: 'yes' },
            ]}
            onSelect={item => finishUninstall(item.value === 'yes')}
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
