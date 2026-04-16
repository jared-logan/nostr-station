import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step, type StepStatus } from '../components/Step.js';
import type { Platform, Config } from '../../lib/detect.js';
import {
  writeRelayConfig, writeWatchdogScript, setupDirs,
  installRelayService, installWatchdogService,
  writeClaudeEnv, writeAiConfigFromOnboard,
  generateWatchdogKeypair, writeContextFile,
  EDITOR_FILENAMES,
} from '../../lib/services.js';
import { installNostrVpn, setupNgitBunker, generateSshKey } from '../../lib/install.js';
import { execa } from 'execa';
import { npubToHex } from '../../lib/detect.js';
import {
  writeIdentity, readIdentity, identityExists, DEFAULT_READ_RELAYS,
} from '../../lib/identity.js';

interface ServicesPhaseProps {
  platform: Platform;
  config: Config;
  onDone: (updatedConfig: Config, sshPubKey: string) => void;
}

type S = { label: string; status: StepStatus; detail?: string };

function humanizeBunkerError(raw: string | undefined): string {
  if (!raw) return 'Amber did not respond — open the app and try again';
  const lower = raw.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out'))
    return 'Amber did not respond — open the app and approve the connection request';
  if (lower.includes('connection refused') || lower.includes('econnrefused'))
    return 'Could not reach Amber — make sure the app is open and the bunker is active';
  if (lower.includes('invalid') || lower.includes('malformed') || lower.includes('parse'))
    return 'Invalid bunker string — copy it again from Amber → Connect apps → your bunker';
  if (lower.includes('unauthori') || lower.includes('rejected') || lower.includes('denied'))
    return 'Amber rejected the request — tap Approve in the app, then retry';
  if (lower.includes('not found') || lower.includes('no such'))
    return 'ngit not found — run: nostr-station update';
  return raw.slice(0, 120);
}

export const ServicesPhase: React.FC<ServicesPhaseProps> = ({ platform, config, onDone }) => {
  const [showStacksNote, setShowStacksNote] = useState(false);
  const [showGhNote, setShowGhNote] = useState(false);
  const [showNsyteNote, setShowNsyteNote] = useState(false);

  const [steps, setSteps] = useState<S[]>([
    { label: 'Directories',        status: 'pending' },
    { label: 'Watchdog keypair',   status: 'pending' },
    { label: 'Relay config',       status: 'pending' },
    { label: 'Watchdog script',    status: 'pending' },
    { label: 'Relay service',      status: 'pending' },
    { label: 'Watchdog service',   status: 'pending' },
    { label: 'nostr-vpn',          status: 'pending' },
    { label: 'ngit bunker',        status: config.bunker ? 'pending' : 'skip' },
    { label: 'SSH key',            status: 'pending' },
    { label: 'AI provider config', status: 'pending' },
    { label: 'NOSTR_STATION.md',   status: 'pending' },
    { label: 'GitHub CLI auth',    status: config.versionControl !== 'ngit' ? 'pending' : 'skip' },
    { label: 'nsyte bunker',       status: (config.installNsyte && !!config.bunker) ? 'pending' : 'skip' },
  ]);

  const up = (i: number, patch: Partial<S>) =>
    setSteps(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s));

  useEffect(() => {
    (async () => {
      let cfg = { ...config };

      // Dirs
      up(0, { status: 'running' });
      try { setupDirs(platform); up(0, { status: 'done' }); }
      catch (e: any) { up(0, { status: 'error', detail: e.message }); }

      // identity.json — seed on fresh install so dashboard, ngit Service Health
      // dot, and Projects → ngit init relay pre-fill all work on first run.
      // If a prior identity.json exists, preserve its fields and only fill in
      // anything missing (e.g. ngitRelay on an upgrade from pre-ngit builds).
      try {
        if (!identityExists()) {
          writeIdentity({
            npub: cfg.npub,
            readRelays: DEFAULT_READ_RELAYS.slice(),
            ngitRelay: 'ws://localhost:8080',
          });
        } else {
          const existing = readIdentity();
          if (!existing.npub || !existing.ngitRelay) {
            writeIdentity({
              npub: existing.npub || cfg.npub,
              readRelays: existing.readRelays,
              ngitRelay: existing.ngitRelay || 'ws://localhost:8080',
              ...(existing.requireAuth === false ? { requireAuth: false } : {}),
            });
          }
        }
      } catch { /* non-fatal — dashboard will prompt if identity is missing */ }

      // Watchdog keypair — nsec stored in keychain, not in script or config
      up(1, { status: 'running' });
      try {
        const kp = await generateWatchdogKeypair(platform.cargoBin);
        cfg = { ...cfg, watchdogNpub: kp.npub };
        up(1, { status: 'done', detail: kp.npub ? `npub: ${kp.npub.slice(0, 12)}… → ${kp.backend}` : undefined });
      } catch (e: any) { up(1, { status: 'error', detail: e.message }); }

      // Relay config — resolve hex pubkey now that nak is installed
      up(2, { status: 'running' });
      try {
        const hex = npubToHex(cfg.npub);
        if (hex) cfg = { ...cfg, hexPubkey: hex };
        writeRelayConfig(platform, cfg);
        up(2, { status: 'done' });
      } catch (e: any) { up(2, { status: 'error', detail: e.message }); }

      // Watchdog script
      up(3, { status: 'running' });
      try { writeWatchdogScript(platform, cfg); up(3, { status: 'done' }); }
      catch (e: any) { up(3, { status: 'error', detail: e.message }); }

      // Relay service
      up(4, { status: 'running' });
      try { installRelayService(platform); up(4, { status: 'done' }); }
      catch (e: any) { up(4, { status: 'error', detail: e.message }); }

      // Watchdog service
      up(5, { status: 'running' });
      try { installWatchdogService(platform); up(5, { status: 'done' }); }
      catch (e: any) { up(5, { status: 'error', detail: e.message }); }

      // nostr-vpn
      up(6, { status: 'running' });
      const vpn = await installNostrVpn(platform.nvpnTarget);
      up(6, { status: vpn.ok ? 'done' : 'error', detail: vpn.detail });

      // ngit bunker
      if (cfg.bunker) {
        up(7, { status: 'running' });
        const ng = await setupNgitBunker(cfg.bunker, platform.cargoBin);
        up(7, { status: ng.ok ? 'done' : 'error', detail: ng.ok ? undefined : humanizeBunkerError(ng.detail) });
      }

      // SSH key
      up(8, { status: 'running' });
      let sshPubKey = '';
      try {
        sshPubKey = await generateSshKey(platform.homeDir);
        up(8, { status: 'done' });
      } catch (e: any) { up(8, { status: 'error', detail: e.message }); }

      // AI provider — writes both the legacy ~/.claude_env loader (used by
      // Claude Code via shell env) AND the new ~/.nostr-station/ai-config.json
      // (used by Chat pane + CLI). Writing both keeps existing shell-env
      // flows working while giving the dashboard a configured provider
      // from first boot.
      up(9, { status: 'running' });
      try {
        const backend = await writeClaudeEnv(platform.homeDir, cfg);
        await writeAiConfigFromOnboard(cfg);
        up(9, { status: 'done', detail: backend });
      } catch (e: any) { up(9, { status: 'error', detail: e.message }); }

      // NOSTR_STATION.md + editor symlink
      up(10, { status: 'running' });
      try {
        writeContextFile(platform, cfg);
        const linked = EDITOR_FILENAMES[cfg.editor] ?? 'AGENTS.md';
        up(10, { status: 'done', detail: `→ ${linked}` });
      } catch (e: any) { up(10, { status: 'error', detail: e.message }); }

      if (cfg.installStacks) setShowStacksNote(true);

      // GitHub CLI auth check
      if (cfg.versionControl !== 'ngit') {
        up(11, { status: 'running' });
        try {
          await execa('gh', ['auth', 'status'], { stdio: 'pipe' });
          up(11, { status: 'done', detail: 'authenticated' });
        } catch {
          up(11, { status: 'skip', detail: 'run: gh auth login' });
          setShowGhNote(true);
        }
      }

      // nsyte bunker connect — reuse the bunker string from ngit setup
      if (cfg.installNsyte) {
        if (cfg.bunker) {
          up(12, { status: 'running' });
          try {
            await execa('nsyte', ['bunker', 'connect', cfg.bunker], { stdio: 'pipe' });
            up(12, { status: 'done' });
          } catch {
            up(12, { status: 'skip', detail: 'run: nsyte bunker connect <bunker-url>' });
            setShowNsyteNote(true);
          }
        } else {
          setShowNsyteNote(true);
        }
      }

      setTimeout(() => onDone(cfg, sshPubKey), 300);
    })();
  }, []);

  return (
    <Box flexDirection="column">
      <PhaseHeader number={4} title="Services &amp; Configuration" />
      {steps.map((s, i) => (
        <Step key={i} label={s.label} status={s.status} detail={s.detail} />
      ))}
      {showStacksNote && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>{'  Stacks uses its own AI provider configuration, separate from your'}</Text>
          <Text>{'  main coding tool. You\'ll set it up when you create your first project:'}</Text>
          <Text> </Text>
          <Text>{'    mkdir my-app && cd my-app'}</Text>
          <Text>{'    stacks mkstack'}</Text>
          <Text> </Text>
          <Text>{'  Run stacks configure any time to change the stacks agent AI provider or API key.'}</Text>
        </Box>
      )}
      {showGhNote && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>{'  GitHub CLI is installed but not yet authenticated. Run this when ready:'}</Text>
          <Text> </Text>
          <Text>{'    gh auth login'}</Text>
          <Text> </Text>
          <Text>{'  This opens a browser-based OAuth flow. Your token is stored securely'}</Text>
          <Text>{'  by gh — never printed to the terminal.'}</Text>
        </Box>
      )}
      {showNsyteNote && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text>{'  nsyte is installed. Connect your Amber bunker to enable nsec-free publishing:'}</Text>
          <Text> </Text>
          <Text>{'    nsyte bunker connect <bunker-url>'}</Text>
          <Text> </Text>
          <Text>{'  Then deploy a site from any project directory:'}</Text>
          <Text>{'    nsyte upload ./dist'}</Text>
        </Box>
      )}
    </Box>
  );
};
