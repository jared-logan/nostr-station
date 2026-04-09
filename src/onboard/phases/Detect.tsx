import React, { useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step } from '../components/Step.js';
import { detectPlatform, detectInstalled, type Platform, type Installed } from '../../lib/detect.js';

interface DetectPhaseProps {
  onDone: (platform: Platform, installed: Installed) => void;
}

export const DetectPhase: React.FC<DetectPhaseProps> = ({ onDone }) => {
  const [platform, setPlatform] = React.useState<Platform | null>(null);
  const [installed, setInstalled] = React.useState<Installed | null>(null);

  useEffect(() => {
    const p = detectPlatform();
    const i = detectInstalled();
    setPlatform(p);
    setInstalled(i);
    setTimeout(() => onDone(p, i), 400);
  }, []);

  if (!platform || !installed) return (
    <Box><Text dimColor>  Detecting environment...</Text></Box>
  );

  const existing = Object.entries(installed)
    .filter(([, v]) => v)
    .map(([k]) => k)
    .join('  ');

  return (
    <Box flexDirection="column">
      <PhaseHeader number={1} title="Environment Detection" />
      <Step label={`${platform.os} / ${platform.arch}`} status="done" />
      <Step label={`Package manager: ${platform.pkgMgr}`} status="done" />
      <Step label={`Services: ${platform.serviceBackend}`} status="done" />
      <Step label={`nostr-vpn target: ${platform.nvpnTarget}`} status="done" />
      {existing && (
        <Box marginTop={1} marginLeft={4}>
          <Text dimColor>Already installed: {existing}</Text>
        </Box>
      )}
    </Box>
  );
};
