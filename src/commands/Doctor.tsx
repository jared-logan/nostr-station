import React, { useState, useEffect } from 'react';
import { Box, Text } from 'ink';
import { Step, type StepStatus } from '../onboard/components/Step.js';
import { P } from '../onboard/components/palette.js';
import { runChecks, type CheckResult } from '../lib/verify.js';
import { execSync } from 'child_process';

interface DoctorProps { fix: boolean; deep: boolean; }

type Check = { label: string; status: StepStatus; detail?: string; fixCmd?: string };

function attempt(cmd: string): boolean {
  try { execSync(cmd, { stdio: 'pipe' }); return true; }
  catch { return false; }
}

export const Doctor: React.FC<DoctorProps> = ({ fix, deep }) => {
  const [checks, setChecks] = useState<Check[]>([]);
  const [done, setDone] = useState(false);
  const [fixed, setFixed] = useState(0);

  useEffect(() => {
    const results: CheckResult[] = runChecks();

    const mapped: Check[] = results.map(r => ({
      label:  r.label,
      status: r.ok ? 'done' : 'error',
      detail: r.ok ? undefined : 'failed',
      fixCmd: !r.ok ? getFix(r.label) : undefined,
    }));

    // Extended checks
    if (deep) {
      mapped.push({
        label: 'NVM in shell PATH',
        status: attempt('command -v nvm') ? 'done' : 'error',
      });
      mapped.push({
        label: 'Cargo bin in PATH',
        status: attempt('command -v cargo') ? 'done' : 'error',
      });
    }

    setChecks(mapped);

    if (fix) {
      let fixCount = 0;
      const fixed = mapped.map(c => {
        if (c.status === 'error' && c.fixCmd) {
          const ok = attempt(c.fixCmd);
          if (ok) { fixCount++; return { ...c, status: 'done' as StepStatus, detail: 'fixed' }; }
          return { ...c, detail: 'fix failed' };
        }
        return c;
      });
      setChecks(fixed);
      setFixed(fixCount);
    }

    setDone(true);
  }, []);

  const failures = checks.filter(c => c.status === 'error').length;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station doctor</Text>
        {deep && <Text color={P.muted}> --deep</Text>}
        {fix  && <Text color={P.muted}> --fix</Text>}
      </Box>

      {checks.map((c, i) => (
        <Step key={i} label={c.label} status={c.status} detail={c.detail} />
      ))}

      {done && (
        <Box marginTop={1} flexDirection="column">
          <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
          {failures === 0 ? (
            <Text color={P.success}>✓ All checks passed</Text>
          ) : fix ? (
            <Text color={fixed > 0 ? P.warn : P.error}>
              {`${failures - fixed} issue(s) remain · ${fixed} fixed`}
            </Text>
          ) : (
            <Text color={P.warn}>
              {`${failures} issue(s) found · run with --fix to repair`}
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
};

function getFix(label: string): string | undefined {
  const fixes: Record<string, string> = {
    'Relay (localhost:8080)': 'launchctl start com.nostr-station.relay 2>/dev/null || systemctl --user start nostr-relay.service',
    'nostr-vpn daemon':       'sudo nvpn service install && nvpn start --daemon --connect',
  };
  return Object.entries(fixes).find(([k]) => label.includes(k.split(' ')[0]))?.[1];
}
