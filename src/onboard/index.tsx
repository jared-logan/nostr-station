import React, { useState } from 'react';
import { Box } from 'ink';
import { Banner } from './components/Banner.js';
import { Summary } from './components/Summary.js';
import { LaunchPicker } from './components/LaunchPicker.js';
import { DetectPhase } from './phases/Detect.js';
import { ConfigPhase } from './phases/Config.js';
import { InstallPhase } from './phases/Install.js';
import { ServicesPhase } from './phases/Services.js';
import { VerifyPhase } from './phases/Verify.js';
import type { Platform, Config, Installed } from '../lib/detect.js';

type Stage =
  | 'detect'
  | 'config'
  | 'install'
  | 'services'
  | 'verify'
  | 'done';

interface OnboardProps {
  demoMode?: boolean;
  // True when cli.tsx has already run `apt-get update && install` pre-Ink
  // (Linux interactive only — see cli.tsx onboard case for why). The
  // Install phase honours this by marking the system-packages row done
  // on entry instead of re-running the install inside the TUI.
  systemDepsPreInstalled?: boolean;
  onLaunch?: (intent: string) => void;
}

export const Onboard: React.FC<OnboardProps> = ({
  demoMode = false,
  systemDepsPreInstalled = false,
  onLaunch,
}) => {
  const [stage, setStage] = useState<Stage>('detect');
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [installed, setInstalled] = useState<Installed | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [sshPubKey, setSshPubKey] = useState('');
  const [meshIp, setMeshIp] = useState<string | undefined>();

  return (
    <Box flexDirection="column" paddingX={1}>
      <Banner />

      {/* Phase 1 — always shown once complete */}
      {stage !== 'detect' && platform && (
        <DetectPhase onDone={() => {}} />
      )}

      {stage === 'detect' && (
        <DetectPhase
          onDone={(p, i) => {
            setPlatform(p);
            setInstalled(i);
            setStage('config');
          }}
        />
      )}

      {/* Phase 2 */}
      {stage === 'config' && (
        <ConfigPhase
          demoMode={demoMode}
          onDone={cfg => {
            setConfig(cfg);
            setStage('install');
          }}
        />
      )}

      {/* Phase 3 */}
      {(stage === 'install' || stage === 'services' || stage === 'verify' || stage === 'done') &&
        platform && installed && config && (
        <InstallPhase
          platform={platform}
          installed={installed}
          config={config}
          systemDepsPreInstalled={systemDepsPreInstalled}
          onDone={() => {
            if (stage === 'install') setStage('services');
          }}
        />
      )}

      {/* Phase 4 */}
      {(stage === 'services' || stage === 'verify' || stage === 'done') &&
        platform && config && (
        <ServicesPhase
          platform={platform}
          config={config}
          onDone={(updatedConfig, key) => {
            setConfig(updatedConfig);
            setSshPubKey(key);
            if (stage === 'services') setStage('verify');
          }}
        />
      )}

      {/* Phase 5 */}
      {(stage === 'verify' || stage === 'done') && config && (
        <VerifyPhase
          config={config}
          sshPubKey={sshPubKey}
          onDone={ip => {
            setMeshIp(ip);
            if (stage === 'verify') setStage('done');
          }}
        />
      )}

      {/* Summary + launch picker */}
      {stage === 'done' && config && (
        <>
          <Summary config={config} meshIp={meshIp} demoMode={demoMode} />
          {!demoMode && (
            <LaunchPicker onLaunch={intent => onLaunch?.(intent)} />
          )}
        </>
      )}
    </Box>
  );
};
