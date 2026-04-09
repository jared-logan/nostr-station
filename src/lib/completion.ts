import os from 'os';
import fs from 'fs';
import path from 'path';

// Shell completion for nostr-station.
// What this does: after running `nostr-station completion --shell zsh --install`,
// typing `nostr-station <TAB>` in your terminal shows available commands.
// It's a standard CLI convention that makes the tool feel native.

const COMMANDS = ['onboard', 'doctor', 'status', 'update', 'logs', 'relay', 'tui', 'setup-editor', 'uninstall', 'completion', 'version'];
const RELAY_SUBCOMMANDS = ['start', 'stop', 'restart', 'status'];
const UPDATE_FLAGS = ['--dry-run', '--yes', '--wizard'];
const DOCTOR_FLAGS = ['--fix', '--repair', '--deep'];
const LOGS_FLAGS = ['--follow', '-f', '--service'];
const LOGS_SERVICES = ['relay', 'watchdog', 'all'];

const ZSH_COMPLETION = `#compdef nostr-station

_nostr_station() {
  local -a commands
  commands=(
    'onboard:Interactive setup wizard'
    'doctor:Health checks and quick fixes'
    'status:Show relay and service status'
    'update:Update all installed components'
    'logs:Tail relay or watchdog logs'
    'relay:Manage the nostr-rs-relay service'
    'tui:Live dashboard'
    'setup-editor:Link NOSTR_STATION.md to your AI coding tool'
    'uninstall:Remove nostr-station'
    'completion:Generate shell completion'
    'version:Print version'
  )

  local -a relay_cmds
  relay_cmds=('start' 'stop' 'restart' 'status')

  local -a log_services
  log_services=('relay' 'watchdog' 'all')

  case $words[2] in
    relay)
      _describe 'relay subcommand' relay_cmds
      ;;
    logs)
      _arguments \\
        '--follow[Tail in real time]' \\
        '-f[Tail in real time]' \\
        '--service[Log source]:service:(relay watchdog all)'
      ;;
    doctor)
      _arguments \\
        '--fix[Attempt automatic repairs]' \\
        '--repair[Attempt automatic repairs]' \\
        '--deep[Extended diagnostics]'
      ;;
    update)
      _arguments \\
        '--dry-run[Preview without applying]' \\
        '--yes[Skip confirmation]' \\
        '--wizard[Interactive update wizard]'
      ;;
    *)
      _describe 'command' commands
      ;;
  esac
}

_nostr_station "$@"
`;

const BASH_COMPLETION = `# bash completion for nostr-station
_nostr_station() {
  local cur prev words cword
  _init_completion || return

  local commands="onboard doctor status update logs relay tui setup-editor uninstall completion version"

  case $prev in
    nostr-station)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return ;;
    relay)
      COMPREPLY=($(compgen -W "start stop restart status" -- "$cur"))
      return ;;
    --service)
      COMPREPLY=($(compgen -W "relay watchdog all" -- "$cur"))
      return ;;
  esac

  case ${words[1]} in
    doctor)
      COMPREPLY=($(compgen -W "--fix --repair --deep" -- "$cur")) ;;
    update)
      COMPREPLY=($(compgen -W "--dry-run --yes --wizard" -- "$cur")) ;;
    logs)
      COMPREPLY=($(compgen -W "--follow -f --service" -- "$cur")) ;;
    status)
      COMPREPLY=($(compgen -W "--json" -- "$cur")) ;;
  esac
}
complete -F _nostr_station nostr-station
`;

export function generateCompletion(shell: 'zsh' | 'bash'): string {
  return shell === 'zsh' ? ZSH_COMPLETION : BASH_COMPLETION;
}

export function installCompletion(shell: 'zsh' | 'bash'): { ok: boolean; path: string; instructions: string } {
  const script = generateCompletion(shell);

  if (shell === 'zsh') {
    // Write to a dir that's likely on fpath
    const completionDir = `${os.homedir()}/.zsh/completions`;
    const completionFile = `${completionDir}/_nostr_station`;
    fs.mkdirSync(completionDir, { recursive: true });
    fs.writeFileSync(completionFile, script);
    return {
      ok: true,
      path: completionFile,
      instructions: [
        `Add to ~/.zshrc if not already present:`,
        `  fpath=(~/.zsh/completions $fpath)`,
        `  autoload -Uz compinit && compinit`,
        `Then: source ~/.zshrc`,
      ].join('\n'),
    };
  } else {
    const completionFile = `${os.homedir()}/.bash_completion.d/nostr-station`;
    fs.mkdirSync(path.dirname(completionFile), { recursive: true });
    fs.writeFileSync(completionFile, script);
    return {
      ok: true,
      path: completionFile,
      instructions: [
        `Add to ~/.bashrc if not already present:`,
        `  [ -d ~/.bash_completion.d ] && for f in ~/.bash_completion.d/*; do source "$f"; done`,
        `Then: source ~/.bashrc`,
      ].join('\n'),
    };
  }
}
