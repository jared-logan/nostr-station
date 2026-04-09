import React, { useState, useEffect } from 'react';
import { Box } from 'ink';
import { PhaseHeader, Step, type StepStatus } from '../components/Step.js';
import type { Platform, Config } from '../../lib/detect.js';
import {
  writeRelayConfig, writeWatchdogScript, setupDirs,
  installRelayService, installWatchdogService,
  writeClaudeEnv, generateWatchdogKeypair, writeContextFile,
  EDITOR_FILENAMES,
} from '../../lib/services.js';
import { installNostrVpn, setupNgitBunker, generateSshKey } from '../../lib/install.js';
import { npubToHex } from '../../lib/detect.js';

interface ServicesPhaseProps {
  platform: Platform;
  config: Config;
  onDone: (updatedConfig: Config, sshPubKey: string) => void;
}

type S = { label: string; status: StepStatus; detail?: string };

export const ServicesPhase: React.FC<ServicesPhaseProps> = ({ platform, config, onDone }) => {
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
    { label: 'NOSTR_STATION.md',      status: 'pending' },
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

      // Watchdog keypair
      up(1, { status: 'running' });
      try {
        const kp = generateWatchdogKeypair(platform.cargoBin);
        cfg = { ...cfg, watchdogNsec: kp.nsec, watchdogNpub: kp.npub };
        up(1, { status: 'done', detail: kp.npub ? `npub: ${kp.npub.slice(0, 12)}…` : undefined });
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
        up(7, { status: ng.ok ? 'done' : 'error', detail: ng.detail });
      }

      // SSH key
      up(8, { status: 'running' });
      let sshPubKey = '';
      try {
        sshPubKey = await generateSshKey(platform.homeDir);
        up(8, { status: 'done' });
      } catch (e: any) { up(8, { status: 'error', detail: e.message }); }

      // AI provider
      up(9, { status: 'running' });
      try { writeClaudeEnv(platform.homeDir, cfg); up(9, { status: 'done' }); }
      catch (e: any) { up(9, { status: 'error', detail: e.message }); }

      // NOSTR_STATION.md + editor symlink
      up(10, { status: 'running' });
      try {
        writeContextFile(platform, cfg);
        const linked = EDITOR_FILENAMES[cfg.editor] ?? 'AGENTS.md';
        up(10, { status: 'done', detail: `→ ${linked}` });
      } catch (e: any) { up(10, { status: 'error', detail: e.message }); }

      setTimeout(() => onDone(cfg, sshPubKey), 300);
    })();
  }, []);

  return (
    <Box flexDirection="column">
      <PhaseHeader number={4} title="Services &amp; Configuration" />
      {steps.map((s, i) => (
        <Step key={i} label={s.label} status={s.status} detail={s.detail} />
      ))}
    </Box>
  );
};
