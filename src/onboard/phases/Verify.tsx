import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { PhaseHeader, Step } from '../components/Step.js';
import { runChecks, getMeshIp, type CheckResult } from '../../lib/verify.js';
import type { Config } from '../../lib/detect.js';

interface VerifyPhaseProps {
  config: Config;
  sshPubKey: string;
  onDone: (meshIp?: string) => void;
}

export const VerifyPhase: React.FC<VerifyPhaseProps> = ({ config, sshPubKey, onDone }) => {
  const [checks, setChecks] = useState<CheckResult[]>([]);
  const [meshIp, setMeshIp] = useState<string | undefined>();
  const [failures, setFailures] = useState(0);

  useEffect(() => {
    const needsClaude = config.aiProvider === 'anthropic' || config.editor === 'claude-code';
    const results = runChecks().filter(r =>
      r.label !== 'claude-code binary' || needsClaude
    );
    const ip = getMeshIp();
    const failed = results.filter(r => !r.ok).length;
    setChecks(results);
    setMeshIp(ip);
    setFailures(failed);
    setTimeout(() => onDone(ip), 600);
  }, []);

  return (
    <Box flexDirection="column">
      <PhaseHeader number={5} title="Verify" />
      {checks.map((c, i) => (
        <Step key={i} label={c.label} status={c.ok ? 'done' : 'error'} />
      ))}

      {checks.length > 0 && (
        <Box marginTop={1} marginLeft={4}>
          {failures === 0
            ? <Text color="green">All checks passed</Text>
            : <Text color="yellow">{failures} check(s) failed — review above</Text>}
        </Box>
      )}

      {sshPubKey && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          <Text bold>GitHub SSH key (add at github.com/settings/keys):</Text>
          <Text dimColor>{sshPubKey}</Text>
        </Box>
      )}
    </Box>
  );
};
