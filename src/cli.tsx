#!/usr/bin/env node
import React from 'react';
import { spawnSync } from 'child_process';
import { render } from 'ink';
import { Onboard }       from './onboard/index.js';
import { Seed }          from './commands/Seed.js';
import { Doctor }        from './commands/Doctor.js';
import { Status, gatherStatus, formatStatusJson } from './commands/Status.js';
import { Update }        from './commands/Update.js';
import { UpdateWizard }  from './commands/UpdateWizard.js';
import { Logs }          from './commands/Logs.js';
import { Relay }         from './commands/Relay.js';
import { Tui }           from './commands/Tui.js';
import { Completion }    from './commands/Completion.js';
import { Uninstall }     from './commands/Uninstall.js';
import { SetupEditor }   from './commands/SetupEditor.js';
import { Nsite }         from './commands/Nsite.js';
import { Keychain }      from './commands/Keychain.js';
import { Push }          from './commands/Push.js';
import { RelayConfigView, RelayWhitelist } from './commands/RelayConfig.js';
import { getKeychain }   from './lib/keychain.js';

const [,, command = 'help', ...args] = process.argv;

const flag = (f: string) => args.includes(f);
const arg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

switch (command) {

  case 'onboard':
    // Pre-authenticate sudo BEFORE Ink mounts.
    //
    // The Install phase runs `sudo apt-get update && sudo apt-get install …`
    // with stdio: 'pipe'. If sudo's credential cache is empty, sudo writes
    // `[sudo] password for <user>:` to the child's stderr and blocks waiting
    // on stdin — which the pipe never drains, so the UI appears to freeze
    // forever. The cleanest fix is to prompt for the password interactively,
    // up-front, in a normal terminal BEFORE Ink takes over the screen and
    // eats user input. `sudo -v` does exactly that: validate + refresh the
    // cache, no command executed.
    //
    // We scope this to Linux only — macOS brew runs unprivileged. All
    // Linux package managers (apt/dnf/pacman) need sudo and all hang the
    // same way if sudo ends up prompting mid-pipe. `--demo` still needs it:
    // demo mode executes the install path in addition to the UI flow.
    //
    // In CI (GitHub Actions), the `runner` user has passwordless sudo, so
    // `sudo -v` returns 0 without touching stdin — this is safe for the
    // e2e workflow that feeds /dev/null as stdin.
    if (process.platform === 'linux') {
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
    }
    render(React.createElement(Onboard, { demoMode: flag('--demo') }));
    break;

  case 'seed':
    render(React.createElement(Seed, {
      eventCount: arg('--events') ? parseInt(arg('--events')!, 10) : 50,
      full: flag('--full'),
    }));
    break;

  case 'doctor':
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
      render(React.createElement(UpdateWizard, null));
    } else {
      render(React.createElement(Update, {
        dryRun: flag('--dry-run'),
        yes:    flag('--yes'),
      }));
    }
    break;

  case 'logs':
    render(React.createElement(Logs, {
      follow:  flag('--follow') || flag('-f'),
      service: (arg('--service') ?? 'relay') as 'relay' | 'watchdog' | 'all',
    }));
    break;

  case 'relay': {
    const relayAction = args[0] ?? 'status';

    if (relayAction === 'config') {
      const authStr   = arg('--auth');
      const dmAuthStr = arg('--dm-auth');
      const authToggle   = authStr   === 'on' ? true : authStr   === 'off' ? false : undefined;
      const dmAuthToggle = dmAuthStr === 'on' ? true : dmAuthStr === 'off' ? false : undefined;
      render(React.createElement(RelayConfigView, { authToggle, dmAuthToggle }));
    } else if (relayAction === 'whitelist') {
      const addNpub    = arg('--add');
      const removeNpub = arg('--remove');
      render(React.createElement(RelayWhitelist, { add: addNpub, remove: removeNpub }));
    } else {
      render(React.createElement(Relay, {
        action: relayAction as 'start' | 'stop' | 'restart' | 'status',
      }));
    }
    break;
  }

  case 'tui':
    render(React.createElement(Tui, null));
    break;

  case 'completion':
    render(React.createElement(Completion, {
      shell:   arg('--shell'),
      install: flag('--install'),
      print:   flag('--print'),
    }));
    break;

  case 'setup-editor':
    render(React.createElement(SetupEditor, null));
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

    render(React.createElement(Keychain, { action: kcAction, key: kcKey }));
    break;
  }

  case 'push':
    render(React.createElement(Push, {
      githubOnly: flag('--github'),
      ngitOnly:   flag('--ngit'),
    }));
    break;

  case 'nsite': {
    const nsiteAction = (args[0] ?? 'status') as 'init' | 'publish' | 'deploy' | 'status' | 'open' | 'help';
    render(React.createElement(Nsite, {
      action: nsiteAction,
      titan:  flag('--titan'),
    }));
    break;
  }

  case 'uninstall':
    render(React.createElement(Uninstall, { yes: flag('--yes') }));
    break;

  case 'version':
  case '--version':
  case '-v':
    console.log('nostr-station 0.0.3');
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
    onboard              Interactive setup wizard (first run)
    doctor               Health checks + quick fixes
    status               Relay, mesh, and service status
    update               Update all components
    update --wizard      Interactive update with version preview
    logs                 Tail relay or watchdog logs
    relay                Manage the nostr-rs-relay service
    tui                  Live dashboard — events, logs, mesh status
    seed                 Seed relay with dummy events for dev/testing
    push                 Push to all configured remotes (git + ngit)
    keychain             Manage credentials stored in the OS keychain
    nsite                Manage nsite publishing (nsyte)
    setup-editor         Link NOSTR_STATION.md to your AI coding tool
    completion           Generate shell tab-completion
    uninstall            Clean removal

  RELAY SUBCOMMANDS
    relay start / stop / restart / status
    relay config                       Show relay configuration
    relay config --auth on|off         Toggle NIP-42 auth
    relay config --dm-auth on|off      Toggle DM auth restriction
    relay whitelist                    List whitelisted npubs
    relay whitelist --add <npub>       Add an npub
    relay whitelist --remove <npub>    Remove an npub (with confirmation)

  FLAGS
    onboard --demo
    doctor  --fix --repair --deep
    status  --json
    update  --dry-run --yes --wizard
    logs    --follow (-f)  --service relay|watchdog|all
    push    --github  --ngit
    nsite   --titan
    seed    --events <n>  --full
    completion  --shell zsh|bash  --install  --print
    uninstall   --yes

  EXAMPLES
    nostr-station onboard
    nostr-station onboard --demo
    nostr-station seed
    nostr-station seed --events 100
    nostr-station seed --full
    nostr-station doctor --fix
    nostr-station logs --follow
    nostr-station relay restart
    nostr-station update --wizard
    nostr-station tui
    nostr-station push
    nostr-station push --github
    nostr-station push --ngit
    nostr-station completion --shell zsh --install
    nostr-station nsite init
    nostr-station nsite publish
    nostr-station nsite publish --dir ./dist
    nostr-station nsite open --titan
    nostr-station keychain list
    nostr-station keychain rotate
  `);
}
