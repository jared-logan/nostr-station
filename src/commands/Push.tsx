import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { P } from '../onboard/components/palette.js';
import {
  getRemotes, isNgitConfigured, getUnpushedCommits,
  getCurrentBranch, isGitRepo, pushToRemote,
  type Remote, type Commit, type PushResult,
} from '../lib/git.js';

interface PushProps {
  githubOnly: boolean;
  ngitOnly: boolean;
}

type Phase = 'loading' | 'summary' | 'pushing' | 'done' | 'error';

export const Push: React.FC<PushProps> = ({ githubOnly, ngitOnly }) => {
  const [phase, setPhase]       = useState<Phase>('loading');
  const [remotes, setRemotes]   = useState<Remote[]>([]);
  const [commits, setCommits]   = useState<Commit[]>([]);
  const [branch, setBranch]     = useState('');
  const [results, setResults]   = useState<PushResult[]>([]);
  const [pushing, setPushing]   = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    if (!isGitRepo()) {
      setErrorMsg('Not a git repository.');
      setPhase('error');
      return;
    }

    const allRemotes = getRemotes();

    // Add virtual ngit remote if ngit is configured but has no git remote
    const detectedRemotes: Remote[] = [...allRemotes];
    if (isNgitConfigured() && !allRemotes.some(r => r.type === 'ngit')) {
      detectedRemotes.push({ name: 'ngit', url: 'Nostr (Amber will sign)', type: 'ngit' });
    }

    // Filter by flag
    const filtered = detectedRemotes.filter(r => {
      if (githubOnly) return r.type === 'github';
      if (ngitOnly)   return r.type === 'ngit';
      return true;
    });

    if (filtered.length === 0) {
      setErrorMsg(
        githubOnly ? 'No GitHub remote found. Add one: git remote add origin https://github.com/<user>/<repo>.git' :
        ngitOnly   ? 'ngit is not configured for this repo. Run: ngit init' :
                     'No remotes configured. Add a GitHub remote or initialize ngit.'
      );
      setPhase('error');
      return;
    }

    const br = getCurrentBranch();
    const githubRemote = filtered.find(r => r.type === 'github');
    const unpushed = getUnpushedCommits(githubRemote?.name ?? 'origin');

    setRemotes(filtered);
    setCommits(unpushed);
    setBranch(br);
    setPhase('summary');
  }, []);

  // Propagate error/partial-failure phases as a non-zero exit code so
  // shell chains (`nostr-station push && make deploy`) don't silently
  // continue after a failed push. process.exitCode lets Ink finish
  // rendering the red error message before the process tears down —
  // a hard process.exit(1) would race the final render.
  useEffect(() => {
    if (phase === 'error') {
      process.exitCode = 1;
    } else if (phase === 'done' && results.some(r => !r.ok)) {
      process.exitCode = 1;
    }
  }, [phase, results]);

  useInput((input, key) => {
    if (phase !== 'summary') return;

    const answer = input.toLowerCase();
    if (key.return || answer === 'y') {
      executePushes();
    } else if (answer === 'n' || key.escape) {
      process.exit(0);
    }
  });

  async function executePushes() {
    setPhase('pushing');
    const out: PushResult[] = [];

    for (const remote of remotes) {
      setPushing(remote.name);
      const result = await pushToRemote(remote, branch);
      out.push(result);
      setResults([...out]);
    }

    setPushing(null);
    setPhase('done');
  }

  // ── Error ────────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station push</Text></Box>
        <Text color={P.error}>{errorMsg}</Text>
      </Box>
    );
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (phase === 'loading') {
    return (
      <Box paddingX={1}><Text color={P.muted}>Checking remotes and commits…</Text></Box>
    );
  }

  // ── Summary + confirm ────────────────────────────────────────────────────
  if (phase === 'summary') {
    const hasMultiple = remotes.length > 1;
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station push</Text></Box>

        {commits.length === 0 ? (
          <Text color={P.muted}>No commits to push.</Text>
        ) : (
          <>
            <Text color={P.muted}>{commits.length} commit{commits.length !== 1 ? 's' : ''} to push:</Text>
            {commits.map((c, i) => (
              <Box key={i} marginLeft={2}>
                <Text color={P.accentDim}>• </Text>
                <Text>{c.message}</Text>
                <Text color={P.muted}>  ({c.age})</Text>
              </Box>
            ))}
          </>
        )}

        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>Remotes:</Text>
          {remotes.map((r, i) => (
            <Box key={i} marginLeft={2}>
              <Text color={P.success}>✓ </Text>
              <Box width={10}><Text>{r.name}</Text></Box>
              <Text color={P.muted}>→ </Text>
              <Text>{r.url}</Text>
              {r.type === 'ngit' && <Text color={P.accentBright}>  (Amber will sign)</Text>}
            </Box>
          ))}
        </Box>

        <Box marginTop={1}>
          {commits.length === 0 ? (
            <Text color={P.muted}>Push anyway? [y/N] </Text>
          ) : hasMultiple ? (
            <Text>Push to all {remotes.length} remotes? [Y/n] </Text>
          ) : (
            <Text>Push? [Y/n] </Text>
          )}
        </Box>
      </Box>
    );
  }

  // ── Pushing ──────────────────────────────────────────────────────────────
  if (phase === 'pushing' || phase === 'done') {
    const allOk = results.every(r => r.ok);

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station push</Text></Box>

        {remotes.map((remote, i) => {
          const result = results.find(r => r.remote === remote.name);
          const isActive = pushing === remote.name;

          return (
            <Box key={i} marginLeft={2}>
              <Box width={4}>
                <Text color={
                  result?.ok ? P.success :
                  result    ? P.error :
                  isActive  ? P.accentBright : P.muted
                }>
                  {result?.ok ? '✓' : result ? '✗' : isActive ? '›' : '○'}
                </Text>
              </Box>
              <Text>{remote.name}</Text>
              {result?.ok && <Text color={P.muted}>  pushed</Text>}
              {result && !result.ok && (
                <Text color={P.error}>  {result.detail ?? 'failed'}</Text>
              )}
              {isActive && <Text color={P.muted}>  pushing…</Text>}
            </Box>
          );
        })}

        {phase === 'done' && (
          <Box marginTop={1}>
            <Text color={allOk ? P.success : P.warn}>
              {allOk
                ? `✓ Done — pushed to ${results.length} remote${results.length !== 1 ? 's' : ''}`
                : `${results.filter(r => !r.ok).length} push(es) failed`}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return null;
};
