#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Seed }       from './commands/Seed.js';
import { Status, gatherStatus, formatStatusJson } from './commands/Status.js';
import { Completion } from './commands/Completion.js';
import { Editor }     from './commands/Editor.js';
import { Nsite }      from './commands/Nsite.js';
import { Keychain }   from './commands/Keychain.js';
import { Publish }    from './commands/Publish.js';
import { Chat }       from './commands/Chat.js';
import { Add }        from './commands/Add.js';
import { Ai, type AiAction } from './commands/Ai.js';
import { getProvider as getAiProvider } from './lib/ai-providers.js';
import { getKeychain }    from './lib/keychain.js';
import { requireInteractive } from './lib/tty.js';
import { VERSION } from './lib/version.js';

// Replace Node's default multi-line stack-trace with a single concise
// stderr line. Exit code stays 1 (matching Node's default for both
// uncaughtException and unhandledRejection on Node ≥15), so script
// callers see no behavioural change — only the dump is shorter.
process.on('uncaughtException', (err: unknown) => {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`nostr-station: uncaught exception\n${msg}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`nostr-station: unhandled promise rejection\n${msg}\n`);
  process.exit(1);
});

// argv[0] is node, argv[1] is this script. When no subcommand is given
// (length === 2) we route to the launcher — boot the dashboard + relay,
// open the browser. An explicit `help` / `--help` / `-h` prints the
// text help instead.
const bareInvocation = process.argv.length === 2;
const [,, command = bareInvocation ? '__welcome__' : 'help', ...args] = process.argv;

const flag = (f: string) => args.includes(f);
const arg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

// Boot the dashboard either via Ink (interactive terminal) or headless
// (no controlling TTY — systemd, docker without -t, etc.). Ink's cursor-
// control escapes flood journald when no PTY is attached, so we bypass
// the React shell entirely and just call startWebServer + print one
// plain stderr line. The server already registers SIGTERM/SIGINT and
// keeps the event loop alive itself, so this path stays foreground and
// shuts down cleanly under systemctl --user stop / docker stop.
async function bootDashboard(port: number, deepPath: string): Promise<void> {
  if (process.stdout.isTTY) {
    render(React.createElement(Chat, { port, path: deepPath }));
    return;
  }
  // Headless path. Lazy-import so a TTY-mode boot doesn't pay for the
  // web-server module's full transitive graph until it's needed.
  const { startWebServer } = await import('./lib/web-server.js');
  try {
    await startWebServer(port);
    process.stderr.write(`Dashboard running at http://localhost:${port}${deepPath}\n`);
  } catch (e: any) {
    process.stderr.write(`nostr-station: dashboard failed to start: ${e?.message ?? e}\n`);
    process.exit(1);
  }
}

switch (command) {

  case 'seed':
    render(React.createElement(Seed, {
      eventCount: arg('--events') ? parseInt(arg('--events')!, 10) : 50,
      full: flag('--full'),
    }));
    break;

  case 'status':
    // --json bypasses Ink entirely so nothing but JSON hits stdout.
    if (flag('--json')) {
      console.log(formatStatusJson(gatherStatus()));
      process.exit(0);
    }
    render(React.createElement(Status, { json: false }));
    break;

  case 'chat':
    void bootDashboard(arg('--port') ? parseInt(arg('--port')!, 10) : 3000, '');
    break;

  case 'serve':
    // Explicit "run the dashboard process" verb. Same behavior as bare
    // invocation — the dashboard server boots the in-process Nostr relay
    // alongside it (see web-server.ts maybeStartInprocRelay). Routes
    // through bootDashboard so a no-TTY invocation (systemd) skips the
    // Ink shell that would otherwise spam the journal with cursor escapes.
    void bootDashboard(3000, '/setup');
    break;

  case '__welcome__':
  case 'start':
  case 'up':
    // Bare invocation + the explicit verbs all do the same thing: render
    // the Chat component, which boots the dashboard + in-process relay
    // and opens the browser. Foreground; Ctrl+C tears down the whole
    // stack cleanly.
    void bootDashboard(3000, '/setup');
    break;

  case 'stop':
  case 'down': {
    // Read the dashboard PID file written by startWebServer and SIGTERM
    // it. The signal handler in web-server.ts runs the same shutdown
    // path as Ctrl+C — closes the relay, unlinks the pid file.
    void (async () => {
      const { probePidFile } = await import('./lib/pid-file.js');
      const status = probePidFile();
      if (status.state === 'absent' || status.state === 'stale') {
        process.stderr.write('nostr-station is not running.\n');
        process.exit(0);
      }
      if (status.state === 'unreadable' || status.state === 'unknown') {
        process.stderr.write(`couldn't read pid file: ${status.state === 'unreadable' ? status.error : status.error ?? 'permission denied'}\n`);
        process.exit(1);
      }
      try {
        process.kill(status.pid, 'SIGTERM');
        process.stderr.write(`stopped (pid ${status.pid}).\n`);
        process.exit(0);
      } catch (e: any) {
        process.stderr.write(`stop failed: ${e?.message ?? e}\n`);
        process.exit(1);
      }
    })();
    break;
  }

  case 'completion':
    if (!arg('--shell')) {
      requireInteractive('completion', 'Pass --shell zsh|bash to skip the picker.');
    }
    render(React.createElement(Completion, {
      shell:   arg('--shell'),
      install: flag('--install'),
      print:   flag('--print'),
    }));
    break;

  case 'editor':
    requireInteractive('editor');
    render(React.createElement(Editor, null));
    break;

  case 'keychain': {
    const kcAction = (args[0] ?? 'list') as 'list' | 'get' | 'set' | 'delete' | 'rotate' | 'migrate';
    const kcKey = args[1];

    // --raw: non-interactive stdout output for use in scripts
    if (kcAction === 'get' && flag('--raw')) {
      getKeychain().retrieve(kcKey as any ?? 'ai-api-key').then(val => {
        if (val) { process.stdout.write(val); process.exit(0); }
        else { process.exit(1); }
      });
      break;
    }

    if (kcAction !== 'list' && kcAction !== 'migrate') {
      const hint = kcAction === 'get'
        ? 'For scripts, use: nostr-station keychain get <key> --raw'
        : undefined;
      requireInteractive(`keychain ${kcAction}`, hint);
    }

    render(React.createElement(Keychain, { action: kcAction, credKey: kcKey }));
    break;
  }

  case 'publish':
    if (!flag('--yes')) {
      requireInteractive('publish', 'Publish confirms before sending — run from a terminal, or pass --yes.');
    }
    render(React.createElement(Publish, {
      githubOnly: flag('--github'),
      ngitOnly:   flag('--ngit'),
      yes:        flag('--yes'),
    }));
    break;

  case 'nsite': {
    const nsiteAction = (args[0] ?? 'status') as 'init' | 'publish' | 'deploy' | 'status' | 'open' | 'help';
    if (nsiteAction === 'init') {
      requireInteractive(`nsite ${nsiteAction}`);
    } else if ((nsiteAction === 'publish' || nsiteAction === 'deploy') && !flag('--yes')) {
      requireInteractive(`nsite ${nsiteAction}`, 'Pass --yes to skip the confirmation.');
    }
    render(React.createElement(Nsite, {
      action: nsiteAction,
      titan:  flag('--titan'),
      yes:    flag('--yes'),
    }));
    break;
  }

  case 'version':
  case '--version':
  case '-v':
    console.log(`nostr-station ${VERSION}`);
    break;

  case 'add':
  case 'list': {
    // `nostr-station add` (no tool)         → list available tools + install state
    // `nostr-station list`                  → same as bare add
    // `nostr-station add <tool>`            → install (interactive y/N confirm)
    // `nostr-station add <tool> --yes`      → install without prompting
    const toolId = command === 'list' ? undefined : args[0];
    if (toolId && !flag('--yes')) {
      requireInteractive('add', 'Pass --yes to skip the confirmation.');
    }
    render(React.createElement(Add, { toolId, yes: flag('--yes') }));
    break;
  }

  case 'relay': {
    // relay export <path>
    // relay import <path> [--dry-run] [--no-verify]
    //
    // I/O-heavy batch ops, no interactive prompts — plain stdout/stderr
    // so they pipe and script cleanly. The implementation lives in
    // commands/Relay.ts as a plain async function (not an Ink component).
    void (async () => {
      const { runRelayCommand } = await import('./commands/Relay.js');
      const action = args[0] ?? 'help';
      const sub    = args.slice(1);
      const code   = await runRelayCommand({ action, args: sub });
      process.exit(code);
    })();
    break;
  }

  case 'relays': {
    // relays list
    // relays add <wss://url> [--read] [--write]
    // relays remove <wss://url>
    // relays pull [--yes]
    // relays publish [--yes]
    //
    // NIP-65 (kind:10002) relay-list control — distinct from the `relay`
    // command which manages the in-process relay's event database. The
    // `s` matters.
    void (async () => {
      const { runRelaysCommand } = await import('./commands/Relays.js');
      const action = args[0] ?? 'help';
      const sub    = args.slice(1);
      const code   = await runRelaysCommand({ action, args: sub });
      process.exit(code);
    })();
    break;
  }

  case 'ai': {
    // ai                        → list
    // ai list                   → list
    // ai add <provider>         → add (interactive key for real API providers)
    // ai remove <provider>      → remove (y/N confirm unless --yes)
    // ai default terminal <p>   → set default
    // ai default chat <p>       → set default
    const aiAction = (args[0] ?? 'list') as AiAction;

    if (aiAction === 'list' || !args[0]) {
      render(React.createElement(Ai, { action: 'list' }));
      break;
    }
    if (aiAction === 'add') {
      if (!args[1]) {
        process.stderr.write('Usage: nostr-station ai add <provider>\nRun `nostr-station ai list` for available ids.\n');
        process.exit(1);
      }
      const provider = args[1];
      const def = getAiProvider(provider);
      const needsKeyPrompt = !!(def && def.type === 'api' && !(def as any).bareKey);
      if (needsKeyPrompt) requireInteractive(
        'ai add',
        process.platform === 'darwin'
          ? 'On macOS the keychain write needs a real terminal — running from the dashboard terminal panel will fail.'
          : undefined,
      );
      render(React.createElement(Ai, { action: 'add', providerId: provider }));
      break;
    }
    if (aiAction === 'remove') {
      if (!args[1]) {
        process.stderr.write('Usage: nostr-station ai remove <provider> [--yes]\n');
        process.exit(1);
      }
      if (!flag('--yes')) requireInteractive('ai remove', 'Pass --yes to skip confirmation.');
      render(React.createElement(Ai, { action: 'remove', providerId: args[1], yes: flag('--yes') }));
      break;
    }
    if (aiAction === 'default') {
      const kind = args[1] as 'terminal' | 'chat';
      const providerId = args[2];
      if ((kind !== 'terminal' && kind !== 'chat') || !providerId) {
        process.stderr.write('Usage: nostr-station ai default <terminal|chat> <provider>\n');
        process.exit(1);
      }
      render(React.createElement(Ai, { action: 'default', kind, providerId }));
      break;
    }
    process.stderr.write(`Unknown ai subcommand: ${aiAction}\n`);
    process.stderr.write('Try: ai list | ai add <p> | ai remove <p> | ai default <terminal|chat> <p>\n');
    process.exit(1);
  }

  case 'help':
  case '--help':
  case '-h':
  default:
    printHelp();
    break;
}

function printHelp() {
  console.log(`
  nostr-station — Nostr-native dev environment

  USAGE
    nostr-station                    Boot the dashboard + relay and open the browser
    nostr-station <command> [options]

  LAUNCHER
    start, up                        Same as bare invocation — boot the dashboard + relay
    stop, down                       Stop the running dashboard (sends SIGTERM via PID file)
    serve                            Run the dashboard process in foreground (alias for bare)

  COMMANDS
    status                           Show relay + service state
    chat                             Web dashboard at localhost:3000
    keychain                         Store, rotate, and inspect credentials in the OS keychain
    ai                               Manage AI providers — add, remove, list, set defaults
    add [tool]                       Install an optional tool (ngit, nak, nsyte) — bare lists them
    list                             Same as bare 'add' — list optional tools + install state
    seed                             Publish test events to your relay
    relay                            Export / import the relay event database as JSONL
    relays                           Manage your NIP-65 (kind:10002) relay list — pull / edit / publish
    publish                          Publish current repo to GitHub + Nostr (ngit) simultaneously
    nsite                            Publish a static site to Nostr via nsyte
    editor                           Re-link NOSTR_STATION.md for a different AI coding tool
    completion                       Install or print shell tab-completion (zsh / bash)
    version                          Print the installed version

  KEYCHAIN SUBCOMMANDS
    keychain list                    List credential slots and whether set
    keychain get <key>               Reveal a credential (y/N confirm)
    keychain get <key> --raw         Print value to stdout (for scripts)
    keychain set <key>               Store/update a credential
    keychain delete <key>            Remove a credential (y/N confirm)
    keychain rotate [key]            Rotate a credential (60s rollback window)
    keychain rotate [key] --rollback Restore the previous value within the window
    keychain migrate                 Migrate legacy on-disk secrets into the OS keychain

  AI SUBCOMMANDS
    ai list                          Show configured providers + defaults
    ai add <provider>                Enable / set up a provider (interactive key for API)
    ai remove <provider> [--yes]     Remove from keychain + ai-config
    ai default terminal <provider>   Set default for "Open in AI" (Claude Code, OpenCode)
    ai default chat <provider>       Set default for the Chat pane

  NSITE SUBCOMMANDS
    nsite init                       Interactive project setup
    nsite publish                    Build check + confirm + upload
    nsite status                     Compare live site with local build
    nsite open [--titan]             Open gateway URL (or copy nsite:// URL)

  RELAY SUBCOMMANDS
    relay export <path>              Stream every event in the store as JSONL
    relay import <path>              Ingest a JSONL file into the relay
    relay import <path> --dry-run    Count what would happen without writing
    relay import <path> --no-verify  Skip signature verification (trusted re-imports)

  RELAYS SUBCOMMANDS (NIP-65 — kind:10002 relay list)
    relays list                      Show local read/write relay lists
    relays add <wss://url>           Add a relay (read + write, NIP-65 default)
    relays add <wss://url> --read    Mark read-only (inbox)
    relays add <wss://url> --write   Mark write-only (outbox)
    relays remove <wss://url>        Remove from both lists
    relays pull [--yes]              Fetch your published kind:10002 + diff + apply on confirm
    relays publish [--yes]           Build kind:10002 from local lists, sign via bunker, broadcast

  ADD SUBCOMMANDS (optional tools)
    add                              List available tools with install state
    add <tool>                       Install (interactive y/N confirm)
    add <tool> --yes                 Install without prompting
    Available tools: ngit, nak, nsyte

  FLAGS
    chat       --port <n>
    status     --json
    publish    --github  --ngit  --yes
    nsite      --titan   --yes
    seed       --events <n>  --full
    keychain   get --raw        rotate --rollback
    add        --yes
    completion --shell zsh|bash  --install  --print
  `);
}
