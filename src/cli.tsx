#!/usr/bin/env node
import React from 'react';
import { render } from 'ink';
import { Onboard }       from './onboard/index.js';
import { Doctor }        from './commands/Doctor.js';
import { Status }        from './commands/Status.js';
import { Update }        from './commands/Update.js';
import { UpdateWizard }  from './commands/UpdateWizard.js';
import { Logs }          from './commands/Logs.js';
import { Relay }         from './commands/Relay.js';
import { Tui }           from './commands/Tui.js';
import { Completion }    from './commands/Completion.js';
import { Uninstall }     from './commands/Uninstall.js';
import { SetupEditor }   from './commands/SetupEditor.js';

const [,, command = 'help', ...args] = process.argv;

const flag = (f: string) => args.includes(f);
const arg  = (f: string) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

switch (command) {

  case 'onboard':
    render(React.createElement(Onboard, null));
    break;

  case 'doctor':
    render(React.createElement(Doctor, {
      fix:  flag('--fix') || flag('--repair'),
      deep: flag('--deep'),
    }));
    break;

  case 'status':
    render(React.createElement(Status, { json: flag('--json') }));
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

  case 'relay':
    render(React.createElement(Relay, {
      action: (args[0] ?? 'status') as 'start' | 'stop' | 'restart' | 'status',
    }));
    break;

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

  case 'uninstall':
    render(React.createElement(Uninstall, { yes: flag('--yes') }));
    break;

  case 'version':
  case '--version':
  case '-v':
    console.log('nostr-station 0.1.0');
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
    setup-editor         Link NOSTR_STATION.md to your AI coding tool
    completion           Generate shell tab-completion
    uninstall            Clean removal

  RELAY SUBCOMMANDS
    relay start / stop / restart / status

  FLAGS
    doctor  --fix --repair --deep
    status  --json
    update  --dry-run --yes --wizard
    logs    --follow (-f)  --service relay|watchdog|all
    completion  --shell zsh|bash  --install  --print
    uninstall   --yes

  EXAMPLES
    nostr-station onboard
    nostr-station doctor --fix
    nostr-station logs --follow
    nostr-station relay restart
    nostr-station update --wizard
    nostr-station tui
    nostr-station completion --shell zsh --install
  `);
}
