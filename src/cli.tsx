#!/usr/bin/env node
import React from 'react';
import { spawnSync } from 'child_process';
import { render } from 'ink';
import { Onboard }       from './onboard/index.js';
import { Seed }          from './commands/Seed.js';
import { Doctor, runDoctorPlain } from './commands/Doctor.js';
import { Status, gatherStatus, formatStatusJson } from './commands/Status.js';
import { Update }        from './commands/Update.js';
import { UpdateWizard }  from './commands/UpdateWizard.js';
import { Logs }          from './commands/Logs.js';
import { Relay }         from './commands/Relay.js';
import { Tui }           from './commands/Tui.js';
import { Completion }    from './commands/Completion.js';
import { Uninstall }     from './commands/Uninstall.js';
import { Editor }        from './commands/Editor.js';
import { Nsite }         from './commands/Nsite.js';
import { Keychain }      from './commands/Keychain.js';
import { Publish }       from './commands/Publish.js';
import { Chat }          from './commands/Chat.js';
import { RelayConfigView, RelayWhitelist } from './commands/RelayConfig.js';
import { Ai, type AiAction } from './commands/Ai.js';
import { getProvider as getAiProvider } from './lib/ai-providers.js';
import { getKeychain }   from './lib/keychain.js';
import { requireInteractive } from './lib/tty.js';
import { detectPlatform } from './lib/detect.js';
import { installSystemDepsInherit } from './lib/install.js';
import { VERSION } from './lib/version.js';

// argv[0] is node, argv[1] is this script. When no subcommand is given
// (length === 2) we route to the web-first welcome flow instead of
// printing help — the spec's "nostr-station → browser" behavior. An
// explicit `help` / `--help` / `-h` still prints the text help.
const bareInvocation = process.argv.length === 2;
const [,, command = bareInvocation ? '__welcome__' : 'help', ...args] = process.argv;

const flag = (f: string) => args.includes(f);
const arg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

switch (command) {

  case 'onboard':
    // --demo is the explicit non-interactive path — takes no prompts and
    // produces deterministic output for screenshots / CI. Gating it behind
    // the TTY check broke e2e-linux (stdin is /dev/null in GH Actions).
    if (!flag('--demo')) requireInteractive('onboard');
    // Pre-Ink steps, in order:
    //
    //   1. sudo -v — warm the credential cache so later elevated calls
    //      don't deadlock on a password prompt inside a piped subprocess.
    //
    //   2. apt-get update && apt-get install — install system packages
    //      BEFORE Ink mounts. Discovered the hard way that running these
    //      inside the Ink TUI on Linux Mint hangs sudo indefinitely even
    //      with `sudo -n` + non-interactive env + proper pipe drain; the
    //      same spawn config outside Ink completes in ~4s (verified via
    //      scripts/repro-apt-hang.mjs). The interaction between Ink's
    //      raw-mode stdin and sudo's PAM/TTY setup is the culprit. We
    //      dodge it by doing the longest Linux step pre-Ink with
    //      stdio: 'inherit' — user sees native apt output, no pipes.
    //
    // Both steps are Linux-only:
    //   - macOS brew runs unprivileged (no sudo) and has never hung in Ink
    //   - Non-TTY stdin (CI): sudo can't prompt anyway; let InstallPhase
    //     handle system deps so non-interactive runs still work end-to-end.
    //   - Demo mode: skip pre-Ink install (demo is for screenshots, and
    //     running real apt would surprise someone just exploring the UI).
    const isLinuxInteractive = process.platform === 'linux' && !!process.stdin.isTTY;
    const demoMode = flag('--demo');

    (async () => {
      let systemDepsPreInstalled = false;

      if (isLinuxInteractive && !demoMode) {
        process.stderr.write(
          'nostr-station needs sudo to install system packages.\n'
          + 'You may be prompted for your password once.\n',
        );
        const preAuth = spawnSync('sudo', ['-v'], { stdio: 'inherit' });
        if (preAuth.status !== 0) {
          process.stderr.write(
            '\nsudo authentication failed or was cancelled — aborting.\n'
            + 'Retry: nostr-station onboard\n',
          );
          process.exit(1);
        }

        process.stderr.write('\nInstalling system packages (one-time, ~1–3 min)…\n\n');
        const sys = await installSystemDepsInherit(detectPlatform());
        if (!sys.ok) {
          process.stderr.write(
            `\nSystem package install failed: ${sys.detail ?? 'unknown error'}\n`
            + 'Retry: nostr-station onboard\n',
          );
          process.exit(1);
        }
        systemDepsPreInstalled = true;
        process.stderr.write('\nSystem packages ready. Starting onboard…\n\n');
      }

      let launchIntent = '';
      const { waitUntilExit } = render(React.createElement(Onboard, {
        demoMode,
        systemDepsPreInstalled,
        onLaunch: (intent: string) => { launchIntent = intent; },
      }));
      await waitUntilExit();
      if (launchIntent === 'tui')  spawnSync('nostr-station', ['tui'],  { stdio: 'inherit' });
      if (launchIntent === 'chat') spawnSync('nostr-station', ['chat'], { stdio: 'inherit' });
    })();
    break;

  case 'seed':
    render(React.createElement(Seed, {
      eventCount: arg('--events') ? parseInt(arg('--events')!, 10) : 50,
      full: flag('--full'),
    }));
    break;

  case 'doctor':
    // --plain bypasses Ink entirely — emits one-line-per-check text so
    // non-TTY consumers (web dashboard SSE modal, CI jobs) get readable
    // output instead of Ink's screen-redraw frames.
    if (flag('--plain')) {
      const code = runDoctorPlain({
        fix:  flag('--fix') || flag('--repair'),
        deep: flag('--deep'),
      });
      process.exit(code);
    }
    render(React.createElement(Doctor, {
      fix:  flag('--fix') || flag('--repair'),
      deep: flag('--deep'),
    }));
    break;

  case 'status':
    // --json bypasses Ink entirely so nothing but JSON hits stdout.
    // Mounting the Ink component would render UI frames that corrupt the
    // payload for downstream parsers (jq, python -m json.tool, CI checks).
    if (flag('--json')) {
      console.log(formatStatusJson(gatherStatus()));
      process.exit(0);
    }
    render(React.createElement(Status, { json: false }));
    break;

  case 'update':
    if (flag('--wizard')) {
      requireInteractive('update --wizard', 'Use `nostr-station update --yes` for non-interactive updates.');
      render(React.createElement(UpdateWizard, null));
    } else {
      render(React.createElement(Update, {
        dryRun: flag('--dry-run'),
        yes:    flag('--yes'),
      }));
    }
    break;

  case 'chat':
    render(React.createElement(Chat, {
      port: arg('--port') ? parseInt(arg('--port')!, 10) : 3000,
    }));
    break;

  case '__welcome__':
    // No-args entry — boots the dashboard and deep-links the browser
    // to the setup wizard at /setup. If the station is already set up
    // the wizard short-circuits to the dashboard (handled in 6.2+).
    render(React.createElement(Chat, { port: 3000, path: '/setup' }));
    break;

  case 'logs':
    // Deprecated alias for `relay logs` — kept one release cycle.
    process.stderr.write('⚠ "logs" is deprecated — use "relay logs" instead.\n');
    render(React.createElement(Logs, {
      follow:  flag('--follow') || flag('-f'),
      service: (arg('--service') ?? 'relay') as 'relay' | 'watchdog' | 'all',
    }));
    break;

  case 'relay': {
    const relayAction = args[0] ?? 'status';

    if (relayAction === 'logs') {
      render(React.createElement(Logs, {
        follow:  flag('--follow') || flag('-f'),
        service: (arg('--service') ?? 'relay') as 'relay' | 'watchdog' | 'all',
      }));
      break;
    }

    if (relayAction === 'config') {
      const authStr   = arg('--auth');
      const dmAuthStr = arg('--dm-auth');
      const authToggle   = authStr   === 'on' ? true : authStr   === 'off' ? false : undefined;
      const dmAuthToggle = dmAuthStr === 'on' ? true : dmAuthStr === 'off' ? false : undefined;
      // Toggling a flag triggers a y/N confirmation; view-only mode is non-interactive.
      if (authToggle !== undefined || dmAuthToggle !== undefined) {
        requireInteractive('relay config', 'Confirmation prompt — run from a terminal.');
      }
      render(React.createElement(RelayConfigView, { authToggle, dmAuthToggle }));
    } else if (relayAction === 'whitelist') {
      const addNpub    = arg('--add');
      const removeNpub = arg('--remove');
      // --remove has a y/N confirmation; list and --add are non-interactive.
      if (removeNpub) {
        requireInteractive('relay whitelist --remove', 'Confirmation prompt — run from a terminal.');
      }
      render(React.createElement(RelayWhitelist, { add: addNpub, remove: removeNpub }));
    } else {
      render(React.createElement(Relay, {
        action: relayAction as 'start' | 'stop' | 'restart' | 'status',
      }));
    }
    break;
  }

  case 'tui':
    requireInteractive('tui', 'Use `nostr-station status` for a non-interactive snapshot.');
    render(React.createElement(Tui, null));
    break;

  case 'completion':
    // With --shell, the picker is skipped and the command is non-interactive.
    if (!arg('--shell')) {
      requireInteractive('completion', 'Pass --shell zsh|bash to skip the picker.');
    }
    render(React.createElement(Completion, {
      shell:   arg('--shell'),
      install: flag('--install'),
      print:   flag('--print'),
    }));
    break;

  case 'setup-editor':
    // Deprecated alias for `editor` — kept one release cycle.
    process.stderr.write('⚠ "setup-editor" is deprecated — use "editor" instead.\n');
    // fallthrough
  case 'editor':
    requireInteractive('editor');
    render(React.createElement(Editor, null));
    break;

  case 'keychain': {
    const kcAction = (args[0] ?? 'list') as 'list' | 'get' | 'set' | 'delete' | 'rotate' | 'migrate';
    const kcKey = args[1];

    // --raw: non-interactive stdout output for use in scripts (.claude_env, watchdog)
    if (kcAction === 'get' && flag('--raw')) {
      getKeychain().retrieve(kcKey as any ?? 'ai-api-key').then(val => {
        if (val) { process.stdout.write(val); process.exit(0); }
        else { process.exit(1); }
      });
      break;
    }

    // list / migrate are display-only; the rest prompt for input or y/N.
    if (kcAction !== 'list' && kcAction !== 'migrate') {
      const hint = kcAction === 'get'
        ? 'For scripts, use: nostr-station keychain get <key> --raw'
        : undefined;
      requireInteractive(`keychain ${kcAction}`, hint);
    }

    render(React.createElement(Keychain, { action: kcAction, credKey: kcKey }));
    break;
  }

  case 'push':
    // Deprecated alias for `publish` — kept one release cycle.
    process.stderr.write('⚠ "push" is deprecated — use "publish" instead.\n');
    // fallthrough
  case 'publish':
    // --yes skips the y/N confirmation (used by the web dashboard exec
    // endpoint, which confirms with the user in the UI before POSTing).
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
    // init is a full wizard; publish/deploy ask y/N before uploading (unless
    // --yes, used by the web dashboard which confirms in the UI). The rest
    // (status, open, help) are read-only.
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

  case 'uninstall':
    // --yes skips the confirmation Select; otherwise the picker needs a TTY.
    if (!flag('--yes')) {
      requireInteractive('uninstall', 'Pass --yes to skip the confirmation.');
    }
    render(React.createElement(Uninstall, { yes: flag('--yes') }));
    break;

  case 'watchdog': {
    // Container-mode watchdog. Defaults match the env vars gatherStatus()
    // reads, so a default invocation in compose lines up with the dashboard
    // probe with no extra flags.
    const loop          = flag('--loop');
    const intervalSec   = arg('--interval')       ? parseInt(arg('--interval')!,       10) : 60;
    const heartbeatPath = arg('--heartbeat-file') ?? process.env.WATCHDOG_HEARTBEAT
                          ?? '/var/run/nostr-station/watchdog.heartbeat';
    const relayHost     = arg('--relay-host')     ?? process.env.RELAY_HOST ?? 'localhost';
    const relayPort     = arg('--relay-port')     ? parseInt(arg('--relay-port')!,     10)
                          : Number(process.env.RELAY_PORT ?? '8080');

    void import('./commands/Watchdog.js').then(({ runWatchdogCli }) =>
      runWatchdogCli({ loop, intervalSec, heartbeatPath, relayHost, relayPort })
    ).catch((e: Error) => {
      process.stderr.write(`watchdog: ${e.message}\n`);
      process.exit(1);
    });
    break;
  }

  case 'version':
  case '--version':
  case '-v':
    console.log(`nostr-station ${VERSION}`);
    break;

  case 'ai': {
    // Subcommand parsing:
    //   ai                        → list
    //   ai list                   → list
    //   ai add <provider>         → add (interactive key for real API providers)
    //   ai remove <provider>      → remove (y/N confirm unless --yes)
    //   ai default terminal <p>   → set default
    //   ai default chat <p>       → set default
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
      // macOS keychain note: writing the key needs an Aqua session, which
      // means running from iTerm / Terminal.app — NOT from the dashboard's
      // terminal panel (PTY setsid drops the Aqua bootstrap). This gate
      // exists to prompt for input; surface the reason if they're about
      // to hit it blind.
      const provider = args[1];
      // Only prompt-interactive for API providers that need a real key.
      // Terminal-native / bareKey adds are non-interactive (no prompts).
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
    nostr-station                    Open the web dashboard (or setup wizard on first run)
    nostr-station <command> [options]

  COMMANDS
    onboard              Terminal setup wizard — installs relay, wires up AI + Amber signing
                         (web alternative: nostr-station → /setup)
    doctor               Check system health; --fix auto-repairs common problems
    status               Show relay, mesh, and service state
    update               Fetch and apply the latest versions of all components
    update --wizard      Interactive update with version preview and diff
    relay                Start, stop, restart, configure, and tail logs for the local relay
    tui                  Live dashboard — events, connection map, and logs
    seed                 Publish test events to your relay  (great for smoke-testing)
    publish              Publish current repo to GitHub + Nostr (ngit) simultaneously
    keychain             Store, rotate, and inspect credentials in the OS keychain
    ai                   Manage AI providers — add, remove, list, set defaults
    chat                 Web dashboard at localhost:3000 — chat, relay, logs, status, config
    nsite                Publish a static site to Nostr via nsyte
    editor               Re-link NOSTR_STATION.md for a different AI coding tool
    completion           Install or print shell tab-completion  (zsh / bash)
    uninstall            Remove all nostr-station components cleanly

  RELAY SUBCOMMANDS
    relay start / stop / restart / status
    relay logs                         Tail relay log  (-f to follow)
    relay logs --service <s>           Log source: relay | watchdog | all
    relay config                       Show relay configuration
    relay config --auth on|off         Toggle NIP-42 auth
    relay config --dm-auth on|off      Toggle DM auth restriction
    relay whitelist                    List whitelisted npubs
    relay whitelist --add <npub>       Add an npub
    relay whitelist --remove <npub>    Remove an npub (with confirmation)

  KEYCHAIN SUBCOMMANDS
    keychain list                      List credential slots and whether set
    keychain get <key>                 Reveal a credential (y/N confirm)
    keychain get <key> --raw           Print value to stdout (for scripts)
    keychain set <key>                 Store/update a credential
    keychain delete <key>              Remove a credential (y/N confirm)
    keychain rotate                    Rotate the AI API key
    keychain migrate                   Migrate from ~/.claude_env into keychain

  AI SUBCOMMANDS
    ai list                            Show configured providers + defaults
    ai add <provider>                  Enable / set up a provider (interactive key for API)
    ai remove <provider> [--yes]       Remove from keychain + ai-config
    ai default terminal <provider>     Set default for "Open in AI" (Claude Code, OpenCode)
    ai default chat <provider>         Set default for the Chat pane
    (macOS: \`ai add\` needs a real terminal; the dashboard PTY can't write keychain)

  NSITE SUBCOMMANDS
    nsite init                         Interactive project setup
    nsite publish                      Build check + confirm + upload
    nsite status                       Compare live site with local build
    nsite open [--titan]               Open gateway URL (or copy nsite:// URL)
    nsite help                         Full reference

  FLAGS
    onboard --demo
    chat    --port <n>
    doctor  --fix --repair --deep
    status  --json
    update  --dry-run --yes --wizard
    relay logs  --follow (-f)  --service relay|watchdog|all
    publish --github  --ngit
    nsite   --titan
    seed    --events <n>  --full
    keychain get --raw
    completion  --shell zsh|bash  --install  --print
    uninstall   --yes

  EXAMPLES
    nostr-station onboard
    nostr-station onboard --demo
    nostr-station seed
    nostr-station seed --events 100
    nostr-station seed --full
    nostr-station doctor --fix
    nostr-station relay logs --follow
    nostr-station relay restart
    nostr-station update --wizard
    nostr-station tui
    nostr-station publish
    nostr-station publish --github
    nostr-station publish --ngit
    nostr-station completion --shell zsh --install
    nostr-station nsite init
    nostr-station nsite publish
    nostr-station nsite publish --dir ./dist
    nostr-station nsite open --titan
    nostr-station keychain list
    nostr-station keychain rotate
  `);
}
