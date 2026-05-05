import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { P } from '../cli-ui/palette.js';
import { Select } from '../cli-ui/Select.js';
import {
  TOOLS, detectTool, installTool, getTool,
  type Tool, type DetectResult,
} from '../lib/tools.js';

interface AddProps {
  // When set, install/show the named tool. When empty, render the list
  // view (and let the user pick one to install with --yes-prompt UX).
  toolId?: string;
  // Skip the y/N confirm before running install steps. Used when the
  // user passed `nostr-station add <tool> --yes` non-interactively.
  yes?:    boolean;
}

type ListEntry = { tool: Tool; result: DetectResult };

export const Add: React.FC<AddProps> = ({ toolId, yes = false }) => {
  // ── List mode ──────────────────────────────────────────────────────
  if (!toolId) return <ListView />;

  // ── Install mode ───────────────────────────────────────────────────
  const tool = getTool(toolId);
  if (!tool) return <UnknownToolView toolId={toolId} />;
  return <InstallView tool={tool} yes={yes} />;
};

const ListView: React.FC = () => {
  const [entries, setEntries] = useState<ListEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(
      Object.values(TOOLS).map(async (tool): Promise<ListEntry> => ({
        tool,
        result: await detectTool(tool),
      })),
    ).then(rows => { if (!cancelled) setEntries(rows); });
    return () => { cancelled = true; };
  }, []);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station — optional tools</Text>
      </Box>
      <Text color={P.muted}>Install with: nostr-station add &lt;id&gt;</Text>
      <Box marginTop={1} flexDirection="column">
        {entries === null ? (
          <Text color={P.muted}>Probing PATH…</Text>
        ) : entries.map(({ tool, result }) => (
          <Box key={tool.id} flexDirection="column" marginBottom={1}>
            <Box>
              <Text color={result.installed ? P.success : P.muted}>
                {result.installed ? '✓ ' : '○ '}
              </Text>
              <Text color={P.accentBright}>{tool.id.padEnd(8)}</Text>
              <Text color={P.muted}>
                {result.installed
                  ? (result.version ?? 'installed')
                  : 'not installed'}
              </Text>
            </Box>
            <Box marginLeft={4}>
              <Text color={P.muted}>{tool.description}</Text>
            </Box>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

const UnknownToolView: React.FC<{ toolId: string }> = ({ toolId }) => {
  useEffect(() => { process.exitCode = 1; }, []);
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={P.error}>Unknown tool: {toolId}</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={P.muted}>Available:</Text>
        {Object.values(TOOLS).map(t => (
          <Text key={t.id}>  {t.id} — <Text color={P.muted}>{t.description}</Text></Text>
        ))}
      </Box>
    </Box>
  );
};

const InstallView: React.FC<{ tool: Tool; yes: boolean }> = ({ tool, yes }) => {
  const [phase, setPhase] = useState<'probing' | 'confirm' | 'installing' | 'done' | 'manual' | 'already'>('probing');
  const [logLines, setLogLines] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  // Initial detection — short-circuits to "already installed" if the
  // binary is on PATH, otherwise advances to confirm/install.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await detectTool(tool);
      if (cancelled) return;
      if (r.installed) {
        setVersion(r.version);
        setPhase('already');
        return;
      }
      setPhase(yes ? 'installing' : 'confirm');
    })();
    return () => { cancelled = true; };
  }, []);

  // When entering 'installing', kick off the install. (Either from
  // --yes shortcut above or after the user confirms.)
  useEffect(() => {
    if (phase !== 'installing') return;
    let cancelled = false;
    (async () => {
      const r = await installTool(tool, line => {
        if (!cancelled) setLogLines(prev => [...prev.slice(-100), line]);
      });
      if (cancelled) return;
      if (r.ok) {
        // Re-detect to surface the installed version in the success line.
        const after = await detectTool(tool);
        if (!cancelled) {
          setVersion(after.version);
          setPhase('done');
        }
      } else if (r.ranSteps === 0 && tool.installSteps[0]?.kind === 'manual') {
        setPhase('manual');
      } else {
        setError(r.detail || 'install failed');
        setPhase('done');
      }
    })();
    return () => { cancelled = true; };
  }, [phase]);

  useEffect(() => {
    if (phase === 'done' && error) process.exitCode = 1;
  }, [phase, error]);

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text color={P.accent} bold>nostr-station add {tool.id}</Text>
      </Box>

      {phase === 'probing' && <Text color={P.muted}>Checking whether {tool.binary} is on PATH…</Text>}

      {phase === 'already' && (
        <Box flexDirection="column">
          <Box>
            <Text color={P.success}>✓ </Text>
            <Text>{tool.id} is already installed{version ? ` (${version})` : ''}.</Text>
          </Box>
          <Box marginTop={1}><Text color={P.muted}>{tool.description}</Text></Box>
        </Box>
      )}

      {phase === 'confirm' && (
        <Box flexDirection="column">
          <Box marginBottom={1}><Text color={P.muted}>{tool.description}</Text></Box>
          {tool.prereqs?.length ? (
            <Box flexDirection="column" marginBottom={1}>
              <Text color={P.warn}>Requires:</Text>
              {tool.prereqs.map(p => (
                <Text key={p} color={P.muted}>  · {p}</Text>
              ))}
            </Box>
          ) : null}
          <Box flexDirection="column" marginBottom={1}>
            <Text color={P.muted}>About to run:</Text>
            {tool.installSteps.map((s, i) => (
              <Text key={i} color={P.accentBright}>  {s.display}</Text>
            ))}
          </Box>
          <Select
            label="Proceed?"
            options={[
              { label: 'Yes — install',   value: 'yes' },
              { label: 'No  — cancel',    value: 'no'  },
            ]}
            onSelect={item => {
              if (item.value === 'yes') setPhase('installing');
              else process.exit(0);
            }}
          />
        </Box>
      )}

      {phase === 'installing' && (
        <Box flexDirection="column">
          <Text color={P.muted}>Installing {tool.id}…</Text>
          <Box flexDirection="column" marginTop={1}>
            {logLines.slice(-12).map((l, i) => (
              <Text key={i} color={P.muted}>{l}</Text>
            ))}
          </Box>
        </Box>
      )}

      {phase === 'manual' && (
        <Box flexDirection="column">
          <Text color={P.warn}>This tool has no automated installer.</Text>
          <Box marginTop={1} flexDirection="column">
            {tool.installSteps.filter(s => s.kind === 'manual').map((s, i) => (
              <Text key={i} color={P.accentBright}>{s.display}</Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color={P.muted}>After installing, re-run </Text>
            <Text color={P.accentBright}>nostr-station add {tool.id}</Text>
            <Text color={P.muted}> to verify.</Text>
          </Box>
        </Box>
      )}

      {phase === 'done' && (
        error ? (
          <Box flexDirection="column">
            <Text color={P.error}>✗ Install failed.</Text>
            <Box marginTop={1}>
              <Text color={P.muted}>{error}</Text>
            </Box>
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={P.success}>✓ {tool.id} installed{version ? ` (${version})` : ''}.</Text>
          </Box>
        )
      )}
    </Box>
  );
};
