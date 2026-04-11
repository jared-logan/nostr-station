import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import { P } from '../onboard/components/palette.js';
import { Prompt } from '../onboard/components/Prompt.js';
import { Select } from '../onboard/components/Select.js';
import { execa, type ExecaError } from 'execa';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

type NsiteAction = 'init' | 'publish' | 'deploy' | 'status' | 'open' | 'help';

interface NsiteProps {
  action: NsiteAction;
  titan?: boolean;   // --titan flag for nsite open
}

const PROJECT_CONFIG_FILE = '.nsite/project.json';
const PUBLISHED_FILE      = '.nsite/published.json';

interface ProjectConfig {
  privateKey: null | string;
  relays: string[];
  servers: string[];
  buildDir: string;
  npub: string;
  name: string;
}

interface PublishedRecord {
  timestamp: string;
  fileCount: number;
  buildDir: string;
}

function readProjectConfig(cwd: string): ProjectConfig | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, PROJECT_CONFIG_FILE), 'utf8'));
  } catch { return null; }
}

function readPublished(cwd: string): PublishedRecord | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(cwd, PUBLISHED_FILE), 'utf8'));
  } catch { return null; }
}

function countFiles(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  try {
    const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[];
    return entries.filter(e => e.isFile()).length;
  } catch { return 0; }
}

function dirMtime(dir: string): Date | null {
  try {
    // Use the most recently modified file in the dir
    const entries = fs.readdirSync(dir, { recursive: true, withFileTypes: true }) as fs.Dirent[];
    const files = entries.filter(e => e.isFile());
    if (!files.length) return null;
    const times = files.map(e => {
      const full = path.join(e.path ?? dir, e.name);
      return fs.statSync(full).mtime;
    });
    return new Date(Math.max(...times.map(t => t.getTime())));
  } catch { return null; }
}

function lastCommitTime(): Date | null {
  try {
    const ts = execSync('git log -1 --format=%ct 2>/dev/null', { stdio: 'pipe' }).toString().trim();
    return ts ? new Date(parseInt(ts) * 1000) : null;
  } catch { return null; }
}

function openUrl(url: string) {
  const bin = process.platform === 'darwin' ? 'open' : 'xdg-open';
  execa(bin, [url], { stdio: 'ignore' }).catch(() => {});
}

function copyToClipboard(text: string) {
  if (process.platform === 'darwin') {
    execa('pbcopy', [], { input: text }).catch(() => {});
  } else {
    execa('xclip', ['-selection', 'clipboard'], { input: text })
      .catch(() => execa('xsel', ['--clipboard', '--input'], { input: text }).catch(() => {}));
  }
}

function addToGitignore(cwd: string, entries: string[]) {
  const ignorePath = path.join(cwd, '.gitignore');
  let current = '';
  try { current = fs.readFileSync(ignorePath, 'utf8'); } catch {}
  const toAdd = entries.filter(e => !current.includes(e));
  if (toAdd.length) {
    fs.writeFileSync(ignorePath, current + (current.endsWith('\n') ? '' : '\n') + toAdd.join('\n') + '\n');
  }
}

// ── Init wizard ────────────────────────────────────────────────────────────

type InitField = 'name' | 'buildDir' | 'servers' | 'relays' | 'signing' | 'npub';

const NsiteInit: React.FC = () => {
  const cwd = process.cwd();
  const configPath = path.join(cwd, PROJECT_CONFIG_FILE);

  const [field, setField] = useState<InitField | 'done' | 'confirm_overwrite'>('name');
  const [values, setValues] = useState({
    name:     path.basename(cwd),
    buildDir: './dist',
    servers:  'cdn.satellite.earth, blossom.primal.net',
    relays:   'wss://relay.damus.io wss://nos.lol',
    signing:  'bunker',
    npub:     '',
  });
  const [input, setInput] = useState('');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const exists = fs.existsSync(configPath);

  useInput((inp) => {
    if (field === 'confirm_overwrite') {
      if (inp.toLowerCase() === 'y') setField('name');
      else process.exit(0);
    }
  });

  useEffect(() => {
    if (exists && field === 'name') {
      setField('confirm_overwrite');
    }
  }, []);

  const set = (f: keyof typeof values, v: string) => {
    setValues(prev => ({ ...prev, [f]: v }));
    setInput('');
  };

  const advance = (next: InitField | 'done') => setField(next);

  const Confirmed = ({ label, value }: { label: string; value: string }) => (
    <Box>
      <Text color={P.success}>  ✓ </Text>
      <Text color={P.muted}>{label}  </Text>
      <Text>{value}</Text>
    </Box>
  );

  if (field === 'confirm_overwrite') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite init</Text></Box>
        <Text color={P.warn}>.nsite/project.json already exists. Overwrite? [y/N]</Text>
      </Box>
    );
  }

  if (field === 'done' || saved) {
    if (!saved) {
      // Write config
      try {
        fs.mkdirSync(path.join(cwd, '.nsite'), { recursive: true });
        const cfg: ProjectConfig = {
          privateKey: values.signing === 'nsec' ? '' : null,
          relays:     values.relays.split(/\s+/).filter(Boolean),
          servers:    values.servers.split(/,\s*/).map(s => `https://${s.trim()}`).filter(s => s !== 'https://'),
          buildDir:   values.buildDir || './dist',
          npub:       values.npub,
          name:       values.name,
        };
        fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n');

        // .gitignore: ignore private keys but allow project.json
        addToGitignore(cwd, ['.nsite/published.json']);

        setSaved(true);
      } catch (e: any) {
        setError(e.message);
      }
    }

    if (error) {
      return <Box paddingX={1}><Text color={P.error}>Failed: {error}</Text></Box>;
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite init</Text></Box>
        <Text color={P.success}>✓ .nsite/project.json written</Text>
        <Text color={P.success}>✓ .nsite/published.json added to .gitignore</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>{'  Safe to commit — no secrets in project.json.'}</Text>
          <Text color={P.muted}>{'  Bunker connection is managed by nsyte, not stored here.'}</Text>
          <Box marginTop={1}>
            <Text color={P.muted}>{'  Next: '}</Text>
            <Text>{'nostr-station nsite publish'}</Text>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite init</Text></Box>
      <Box marginLeft={2} marginBottom={1}>
        <Text color={P.muted}>{'Configure nsite for this project.'}</Text>
      </Box>
      <Box marginLeft={2} marginBottom={1}>
        <Text color={P.muted}>{'Creates .nsite/project.json — commit it to share deploy config.'}</Text>
      </Box>

      {values.name     !== undefined && field !== 'name'     && <Confirmed label="project name"    value={values.name} />}
      {values.buildDir !== undefined && field !== 'buildDir' && <Confirmed label="build dir"       value={values.buildDir} />}
      {values.servers  !== undefined && field !== 'servers'  && field !== 'name' && field !== 'buildDir' && <Confirmed label="Blossom servers" value={values.servers} />}
      {values.relays   !== undefined && field !== 'relays'   && field !== 'name' && field !== 'buildDir' && field !== 'servers' && <Confirmed label="relays" value={values.relays} />}

      {field === 'name' && (
        <Prompt label="Project name" placeholder={path.basename(cwd)} value={input}
          onChange={setInput}
          onSubmit={v => { set('name', v || path.basename(cwd)); advance('buildDir'); }} />
      )}
      {field === 'buildDir' && (
        <Prompt label="Build output directory" placeholder="./dist" value={input}
          onChange={setInput}
          onSubmit={v => { set('buildDir', v || './dist'); advance('servers'); }} />
      )}
      {field === 'servers' && (
        <Prompt label="Blossom servers (comma-separated, without https://)"
          placeholder="cdn.satellite.earth, blossom.primal.net" value={input}
          onChange={setInput}
          onSubmit={v => { set('servers', v || 'cdn.satellite.earth, blossom.primal.net'); advance('relays'); }} />
      )}
      {field === 'relays' && (
        <Prompt label="Relay URLs (space-separated)" placeholder="wss://relay.damus.io wss://nos.lol"
          value={input} onChange={setInput}
          onSubmit={v => { set('relays', v || 'wss://relay.damus.io wss://nos.lol'); advance('npub'); }} />
      )}
      {field === 'npub' && (
        <Prompt label="Your npub (shown in site URL)" placeholder="npub1…" value={input}
          onChange={setInput}
          onSubmit={v => { set('npub', v); advance('signing'); }} />
      )}
      {field === 'signing' && (
        <Select
          label="Signing method"
          options={[
            { label: 'Amber bunker (recommended — nsec stays on your phone)', value: 'bunker' },
            { label: 'nsec directly (not recommended)',                         value: 'nsec'   },
          ]}
          onSelect={item => {
            set('signing', item.value);
            advance('done');
          }}
        />
      )}
    </Box>
  );
};

// ── Publish ────────────────────────────────────────────────────────────────

const NsitePublish: React.FC = () => {
  const cwd = process.cwd();
  const [phase, setPhase] = useState<'checking' | 'confirm' | 'publishing' | 'done' | 'blocked'>('checking');
  const [cfg, setCfg]     = useState<ProjectConfig | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [blockMsg, setBlockMsg] = useState('');
  const [fileCount, setFileCount] = useState(0);
  const [output, setOutput] = useState<string[]>([]);

  useEffect(() => {
    const config = readProjectConfig(cwd);
    if (!config) {
      setBlockMsg('No .nsite/project.json found. Run: nostr-station nsite init');
      setPhase('blocked'); return;
    }

    const buildDir = path.resolve(cwd, config.buildDir ?? './dist');
    if (!fs.existsSync(buildDir)) {
      setBlockMsg(`Build directory not found: ${config.buildDir ?? './dist'}\nBuild your project first, then run nsite publish.`);
      setPhase('blocked'); return;
    }

    const count = countFiles(buildDir);
    if (count === 0) {
      setBlockMsg(`Build directory is empty: ${config.buildDir ?? './dist'}\nBuild your project first.`);
      setPhase('blocked'); return;
    }

    const warns: string[] = [];
    const buildMtime = dirMtime(buildDir);
    const commitTime = lastCommitTime();
    if (buildMtime && commitTime && buildMtime < commitTime) {
      warns.push('⚠  Build is older than the last git commit — you may have forgotten to rebuild.');
    }

    setCfg(config);
    setFileCount(count);
    setWarnings(warns);
    setPhase('confirm');
  }, []);

  // blocked = pre-flight error (missing config, empty build, …). A
  // published-with-errors 'done' phase also needs a non-zero exit so CI
  // pipelines that chain `nsite publish && nsite open` surface the
  // failure instead of silently opening a stale site.
  useEffect(() => {
    if (phase === 'blocked') process.exitCode = 1;
    if (phase === 'done' && output.some(l => l.toLowerCase().includes('error'))) {
      process.exitCode = 1;
    }
  }, [phase, output]);

  useInput((input) => {
    if (phase !== 'confirm') return;
    if (input.toLowerCase() === 'y') executePublish();
    else process.exit(0);
  });

  async function executePublish() {
    if (!cfg) return;
    setPhase('publishing');
    const buildDir = path.resolve(cwd, cfg.buildDir ?? './dist');

    try {
      const args = ['upload', buildDir];
      const proc = execa('nsyte', args, { stdio: 'pipe', cwd });
      const lines: string[] = [];

      proc.stdout?.on('data', (chunk: Buffer) => {
        chunk.toString().split('\n').filter(Boolean).forEach(l => {
          lines.push(l);
          setOutput([...lines]);
        });
      });

      await proc;

      // Record publish
      const record: PublishedRecord = {
        timestamp: new Date().toISOString(),
        fileCount,
        buildDir: cfg.buildDir ?? './dist',
      };
      fs.writeFileSync(path.join(cwd, PUBLISHED_FILE), JSON.stringify(record, null, 2) + '\n');
      setPhase('done');
    } catch (e) {
      const err = e as ExecaError;
      const errLines = (err.stderr?.toString() ?? 'nsyte upload failed').trim().split('\n');
      setOutput(prev => [...prev, ...errLines]);
      setPhase('done');
    }
  }

  if (phase === 'blocked') {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite publish</Text></Box>
        {blockMsg.split('\n').map((l, i) => <Text key={i} color={P.error}>{l}</Text>)}
      </Box>
    );
  }

  if (phase === 'checking') {
    return <Box paddingX={1}><Text color={P.muted}>Checking project…</Text></Box>;
  }

  if (phase === 'confirm' && cfg) {
    const buildDir = cfg.buildDir ?? './dist';
    const npub = cfg.npub || '<your-npub>';
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite publish</Text></Box>
        <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

        <Box><Box width={14}><Text color={P.muted}>Publishing</Text></Box><Text bold>{cfg.name || path.basename(cwd)}</Text></Box>
        <Box><Box width={14}><Text color={P.muted}>From</Text></Box><Text>{buildDir}  ({fileCount} files)</Text></Box>
        <Box><Box width={14}><Text color={P.muted}>Signing</Text></Box><Text>{cfg.privateKey !== null ? 'nsec (direct)' : 'Amber bunker'}</Text></Box>
        <Box><Box width={14}><Text color={P.muted}>Servers</Text></Box><Text>{cfg.servers.map(s => s.replace('https://', '')).join(', ')}</Text></Box>
        <Box><Box width={14}><Text color={P.muted}>Relays</Text></Box><Text>{cfg.relays.join(', ')}</Text></Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={P.muted}>Your site will be live at:</Text>
          <Text color={P.accentBright}>  https://{npub}.nsite.lol</Text>
          <Text color={P.muted}>  nsite://{npub}  (Titan browser)</Text>
        </Box>

        {warnings.map((w, i) => (
          <Box key={i} marginTop={1}><Text color={P.warn}>{w}</Text></Box>
        ))}

        <Box marginTop={1} flexDirection="column">
          <Text color={P.warn}>⚠  This is a public action. Once published, files are on Blossom</Text>
          <Text color={P.warn}>   servers and kind:34128 events are on Nostr relays.</Text>
        </Box>

        <Box marginTop={1}>
          <Text>Publish? [y/N] </Text>
        </Box>
      </Box>
    );
  }

  if (phase === 'publishing' || phase === 'done') {
    const success = phase === 'done' && output.every(l => !l.toLowerCase().includes('error'));
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite publish</Text></Box>
        {phase === 'publishing' && <Text color={P.muted}>Publishing… (Amber will prompt if using bunker)</Text>}
        {output.map((l, i) => <Text key={i} color={P.muted}>{l}</Text>)}
        {phase === 'done' && (
          <Box marginTop={1} flexDirection="column">
            <Text color={success ? P.success : P.warn}>
              {success ? '✓ Published' : '⚠ Publish completed with errors — check output above'}
            </Text>
            {success && cfg && (
              <Text color={P.muted}>  https://{cfg.npub || '<npub>'}.nsite.lol</Text>
            )}
          </Box>
        )}
      </Box>
    );
  }

  return null;
};

// ── Status ─────────────────────────────────────────────────────────────────

const NsiteStatus: React.FC = () => {
  const cwd = process.cwd();
  const cfg = readProjectConfig(cwd);
  const published = readPublished(cwd);

  if (!cfg) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite status</Text></Box>
        <Text color={P.muted}>Not initialized. Run: nostr-station nsite init</Text>
      </Box>
    );
  }

  const buildDir = path.resolve(cwd, cfg.buildDir ?? './dist');
  const localCount = countFiles(buildDir);
  const buildMtime = dirMtime(buildDir);
  const npub = cfg.npub || '<your-npub>';

  const publishedCount = published?.fileCount ?? null;
  const hasDiff = publishedCount !== null && localCount !== publishedCount;
  const neverPublished = publishedCount === null;

  const publishedAgo = published
    ? (() => {
        const diff = Date.now() - new Date(published.timestamp).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins} min ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
        return `${Math.floor(hrs / 24)} days ago`;
      })()
    : null;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite status</Text></Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>

      <Box><Box width={14}><Text color={P.muted}>Project</Text></Box><Text bold>{cfg.name || path.basename(cwd)}</Text></Box>
      <Box><Box width={14}><Text color={P.muted}>Live at</Text></Box><Text color={P.accentBright}>https://{npub}.nsite.lol</Text></Box>
      <Box><Box width={14}><Text color={P.muted}>Published</Text></Box>
        <Text color={neverPublished ? P.muted : 'white'}>
          {neverPublished ? 'never' : `${publishedCount} files  (${publishedAgo})`}
        </Text>
      </Box>
      <Box><Box width={14}><Text color={P.muted}>Local</Text></Box>
        <Text>
          {cfg.buildDir}  — {localCount} file{localCount !== 1 ? 's' : ''}
          {buildMtime ? `  (built ${new Date(buildMtime).toLocaleString()})` : ''}
        </Text>
      </Box>

      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      {neverPublished ? (
        <Text color={P.muted}>Run: nostr-station nsite publish</Text>
      ) : hasDiff ? (
        <Text color={P.warn}>
          ⚠  {Math.abs(localCount - (publishedCount ?? 0))} file{Math.abs(localCount - (publishedCount ?? 0)) !== 1 ? 's' : ''} differ — run nsite publish to update
        </Text>
      ) : (
        <Text color={P.success}>✓ Local build matches published site</Text>
      )}
    </Box>
  );
};

// ── Open ───────────────────────────────────────────────────────────────────

const NsiteOpen: React.FC<{ titan: boolean }> = ({ titan }) => {
  const cwd = process.cwd();
  const cfg = readProjectConfig(cwd);

  useEffect(() => {
    if (!cfg?.npub) return;

    if (titan) {
      const url = `nsite://${cfg.npub}`;
      copyToClipboard(url);
    } else {
      openUrl(`https://${cfg.npub}.nsite.lol`);
    }
  }, []);

  if (!cfg?.npub) {
    return (
      <Box paddingX={1}>
        <Text color={P.error}>No npub found in .nsite/project.json. Run: nostr-station nsite init</Text>
      </Box>
    );
  }

  if (titan) {
    return (
      <Box paddingX={1}>
        <Text color={P.success}>✓ Copied to clipboard: </Text>
        <Text>nsite://{cfg.npub}</Text>
      </Box>
    );
  }

  return (
    <Box paddingX={1}>
      <Text color={P.success}>✓ Opening: </Text>
      <Text>https://{cfg.npub}.nsite.lol</Text>
    </Box>
  );
};

// ── Help ───────────────────────────────────────────────────────────────────

const HELP_LINES = [
  'USAGE',
  '  nostr-station nsite <subcommand> [options]',
  '',
  'SUBCOMMANDS',
  '  init              Interactive setup — creates .nsite/project.json',
  '  publish           Build check + confirm + deploy to Blossom/Nostr',
  '  status            Compare live site with local build',
  '  open              Open gateway URL in browser',
  '  open --titan      Copy nsite:// URL to clipboard',
  '',
  'EXAMPLES',
  '  nostr-station nsite init',
  '  nostr-station nsite publish',
  '  nostr-station nsite status',
  '  nostr-station nsite open',
  '',
  'ACCESS YOUR SITE',
  '  Immediate — no registration needed:',
  '    https://<npub>.nsite.lol     web gateway, any browser',
  '    https://<npub>.nostr.hu      alternative gateway',
  '',
  '  Human-readable name — requires Titan registration:',
  '    nsite://<name>               Titan browser, resolved via Bitcoin OP_RETURN',
  '    Register: https://github.com/btcjt/titan',
  '    Note: name registration is an on-chain Bitcoin transaction.',
  '    Without a Titan name, nsite:// only resolves by full npub.',
  '',
  'TROUBLESHOOTING',
  '  nsyte not found',
  '    → Run: nostr-station onboard  (installs nsyte)',
  '    → Or manually: curl -fsSL https://nsyte.run/get/install.sh | bash',
  '    → Ensure ~/.deno/bin is in your PATH',
  '',
  '  Publish fails with auth error',
  '    → Bunker not connected: nsyte bunker connect <bunker-url>',
  '    → Get your bunker URL from Amber: Settings → Bunker → Copy URL',
  '',
  '  Publish fails — no servers',
  '    → Edit .nsite/project.json and add Blossom servers under "servers"',
  '    → Default servers: cdn.satellite.earth, blossom.primal.net',
  '',
  '  Site not showing at gateway',
  '    → Propagation can take a few minutes — try both gateways',
  '    → Check your relay list in .nsite/project.json',
  '',
  '  nsite://<name> not resolving in Titan',
  '    → Human-readable names require a Titan registration (Bitcoin OP_RETURN)',
  '    → Without registration, use nsite://<your-full-npub> instead',
  '    → See: https://github.com/btcjt/titan',
];

// ── Root ───────────────────────────────────────────────────────────────────

export const Nsite: React.FC<NsiteProps> = ({ action, titan = false }) => {
  // deploy is a backward-compat alias for publish
  const resolved = action === 'deploy' ? 'publish' : action;

  if (resolved === 'init')    return <NsiteInit />;
  if (resolved === 'publish') return <NsitePublish />;
  if (resolved === 'status')  return <NsiteStatus />;
  if (resolved === 'open')    return <NsiteOpen titan={titan} />;

  // help (default)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}><Text color={P.accent} bold>nostr-station nsite</Text></Box>
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
      {HELP_LINES.map((l, i) => (
        <Text key={i} color={l.startsWith('  ') ? P.muted : l === '' ? undefined : 'white'}>{l}</Text>
      ))}
      <Text color={P.accentDim}>{'─────────────────────────────'}</Text>
    </Box>
  );
};
