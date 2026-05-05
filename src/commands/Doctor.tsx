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

// Bypasses Ink so the web dashboard (and CI jobs) can stream doctor output
// as plain terminal text. Ink's screen-redraw frames look garbled in a
// passive log viewer; this gives one-line-per-check output that greps clean.
export function runDoctorPlain(opts: { fix: boolean; deep: boolean }): number {
  const results: CheckResult[] = runChecks();
  const checks: Check[] = results.map(r => ({
    label:  r.label,
    status: r.ok ? 'done' : 'error',
    fixCmd: !r.ok ? getFix(r.label) : undefined,
  }));
  if (opts.deep) {
    checks.push({ label: 'NVM in shell PATH',  status: attempt('command -v nvm')   ? 'done' : 'error' });
    checks.push({ label: 'Cargo bin in PATH',  status: attempt('command -v cargo') ? 'done' : 'error', fixCmd: 'source ~/.cargo/env' });
  }

  const padLabel = Math.max(...checks.map(c => c.label.length), 0) + 2;
  for (const c of checks) {
    const mark = c.status === 'done' ? '✓' : '✗';
    const line = `${mark}  ${c.label.padEnd(padLabel)}${c.status === 'done' ? 'ok' : 'FAIL'}`;
    console.log(line);
    if (c.status !== 'done' && c.fixCmd) console.log(`   ↳ fix: ${c.fixCmd}`);
  }

  let fixedCount = 0;
  if (opts.fix) {
    for (const c of checks) {
      if (c.status === 'error' && c.fixCmd) {
        const ok = attempt(c.fixCmd);
        if (ok) { fixedCount++; console.log(`   → fixed: ${c.label}`); }
        else    { console.log(`   ✗ fix failed: ${c.label}`); }
      }
    }
  }

  const failures  = checks.filter(c => c.status === 'error').length;
  const remaining = opts.fix ? Math.max(0, failures - fixedCount) : failures;
  console.log('---');
  if (remaining === 0) console.log('All checks passed');
  else                 console.log(`${remaining} issue(s) remain${opts.fix ? ` · ${fixedCount} fixed` : ''}`);

  return remaining === 0 ? 0 : 1;
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
        fixCmd: 'source ~/.cargo/env',
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
  const actionable = checks.filter(c => c.status === 'error' && c.fixCmd);

  // Exit 1 if any checks are still failing after --fix (or without it).
  // Lets `nostr-station doctor && nostr-station publish` short-circuit on
  // a broken environment instead of pushing into a half-configured box.
  useEffect(() => {
    if (done && failures > 0) process.exitCode = 1;
  }, [done, failures]);

  // Pad label to a fixed width so fix commands line up cleanly.
  const PAD = Math.max(0, ...actionable.map(c => c.label.length)) + 2;

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
            <>
              <Text color={P.warn}>{`${failures} issue(s) found`}</Text>
              {actionable.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  <Text bold>Quick fixes:</Text>
                  {actionable.map((c, i) => (
                    <Box key={i} marginLeft={2}>
                      <Box width={PAD}><Text color={P.muted}>{c.label}</Text></Box>
                      <Text color={P.accentBright}>{c.fixCmd}</Text>
                    </Box>
                  ))}
                  <Box marginTop={1}>
                    <Text color={P.muted}>Or run </Text>
                    <Text>nostr-station doctor --fix</Text>
                    <Text color={P.muted}> to apply all automatically</Text>
                  </Box>
                </Box>
              )}
            </>
          )}
        </Box>
      )}
    </Box>
  );
};

function getFix(label: string): string | undefined {
  // Container mode: every actionable fix has to run on the host (docker
  // compose isn't reachable from inside the unprivileged station container).
  // We still emit the strings so the dashboard's Quick-Fixes section tells
  // users exactly what to type — auto-`--fix` will fail to exec these, but
  // displaying them is the high-value path.
  if (process.env.STATION_MODE === 'container') {
    if (label.startsWith('Relay (')) return 'nostr-station start  # on host';
    if (label === 'Watchdog heartbeat') return 'nostr-station start  # on host';
    if (label === 'Relay NIP-11 response') {
      return 'docker compose -f ~/.nostr-station/compose/docker-compose.yml restart relay  # on host';
    }
    // Binaries are baked into the station image — the fix is a rebuild.
    if (
      label === 'ngit binary' ||
      label === 'claude-code binary' ||
      label === 'nak binary' ||
      label === 'stacks binary'
    ) {
      return 'docker compose -f ~/.nostr-station/compose/docker-compose.yml build station  # on host';
    }
    return undefined;
  }

  // For `nostr-vpn daemon` we surface the start command rather than
  // `sudo nvpn service install`: on a fresh box the wizard already ran
  // service install, so the unit is on disk — the common cause of a failing
  // check is simply that the service is stopped. `systemctl start nvpn` is
  // idempotent; if the unit is actually missing it'll fail with a clear
  // error, which is a better signal than reinstalling the service every
  // time doctor reports a miss.
  const nvpnFix = process.platform === 'darwin'
    ? 'sudo launchctl kickstart -k system/com.nostr-vpn.nvpn'
    : 'sudo systemctl start nvpn';

  const fixes: Record<string, string> = {
    'Relay (localhost:8080)':
      process.platform === 'darwin'
        ? 'launchctl start com.nostr-station.relay'
        : 'systemctl --user start nostr-relay.service',
    'nostr-rs-relay binary':  'nostr-station update',
    'nostr-vpn daemon':       nvpnFix,
    'ngit binary':            'nostr-station update',
    'nak binary':             'nostr-station update',
    'claude-code binary':     'npm install -g @anthropic-ai/claude-code',
    'Relay NIP-11 response':  'nostr-station relay restart',
  };
  return fixes[label];
}
