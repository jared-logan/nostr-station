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
import { getKeychain }   from './lib/keychain.js';
import { requireInteractive } from './lib/tty.js';
import { detectPlatform } from './lib/detect.js';
import { installSystemDepsInherit } from './lib/install.js';
import { VERSION } from './lib/version.js';

const [,, command = 'help', ...args] = process.argv;

const flag = (f: string) => args.includes(f);
const arg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

switch (command) {

  case 'onboard':
    requireInteractive('onboard');
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

    render(React.createElement(Keychain, { action: kcAction, key: kcKey }));
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

  case 'version':
  case '--version':
  case '-v':
    console.log(`nostr-station ${VERSION}`);
    break;

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
    nostr-station <command> [options]

  COMMANDS
    onboard              First-time setup — installs relay, wires up AI provider + Amber signing
    doctor               Check system health; --fix auto-repairs common problems
    status               Show relay, mesh, and service state
    update               Fetch and apply the latest versions of all components
    update --wizard      Interactive update with version preview and diff
    relay                Start, stop, restart, configure, and tail logs for the local relay
    tui                  Live dashboard — events, connection map, and logs
    seed                 Publish test events to your relay  (great for smoke-testing)
    publish              Publish current repo to GitHub + Nostr (ngit) simultaneously
    keychain             Store, rotate, and inspect credentials in the OS keychain
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
