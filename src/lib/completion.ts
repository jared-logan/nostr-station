import os from 'os';
import fs from 'fs';
import path from 'path';

// Shell completion for nostr-station.
// What this does: after running `nostr-station completion --shell zsh --install`,
// typing `nostr-station <TAB>` in your terminal shows available commands.
// It's a standard CLI convention that makes the tool feel native.

const COMMANDS = ['onboard', 'doctor', 'status', 'update', 'logs', 'relay', 'tui', 'seed', 'push', 'keychain', 'nsite', 'setup-editor', 'uninstall', 'completion', 'version'];
const KEYCHAIN_SUBCOMMANDS = ['list', 'get', 'set', 'delete', 'rotate', 'migrate'];
const KEYCHAIN_KEYS = ['ai-api-key', 'watchdog-nsec'];
const NSITE_SUBCOMMANDS = ['init', 'publish', 'deploy', 'status', 'open', 'help'];
const PUSH_FLAGS = ['--github', '--ngit'];
const RELAY_SUBCOMMANDS = ['start', 'stop', 'restart', 'status', 'config', 'whitelist'];
const RELAY_CONFIG_FLAGS = ['--auth', '--dm-auth'];
const RELAY_WHITELIST_FLAGS = ['--add', '--remove'];
const ONBOARD_FLAGS = ['--demo'];
const UPDATE_FLAGS = ['--dry-run', '--yes', '--wizard'];
const DOCTOR_FLAGS = ['--fix', '--repair', '--deep'];
const LOGS_FLAGS = ['--follow', '-f', '--service'];
const LOGS_SERVICES = ['relay', 'watchdog', 'all'];
const SEED_FLAGS = ['--events', '--full'];

const ZSH_COMPLETION = `#compdef nostr-station

_nostr_station() {
  local -a commands
  commands=(
    'onboard:Interactive setup wizard (--demo for throwaway keypair)'
    'doctor:Health checks and quick fixes'
    'status:Show relay and service status'
    'update:Update all installed components'
    'logs:Tail relay or watchdog logs'
    'relay:Manage the nostr-rs-relay service'
    'tui:Live dashboard'
    'seed:Seed relay with dummy events for testing'
    'keychain:Manage credentials in the OS keychain'
    'push:Push to all configured remotes (git + ngit)'
    'nsite:Manage nsite publishing (nsyte)'
    'setup-editor:Link NOSTR_STATION.md to your AI coding tool'
    'uninstall:Remove nostr-station'
    'completion:Generate shell completion'
    'version:Print version'
  )

  local -a relay_cmds keychain_cmds keychain_keys nsite_cmds log_services
  relay_cmds=('start' 'stop' 'restart' 'status' 'config' 'whitelist')
  keychain_cmds=('list' 'get' 'set' 'delete' 'rotate' 'migrate')
  keychain_keys=('ai-api-key' 'watchdog-nsec')
  nsite_cmds=('init' 'publish' 'deploy' 'status' 'open' 'help')
  log_services=('relay' 'watchdog' 'all')

  case $words[2] in
    onboard)
      _arguments \\
        '--demo[Use throwaway keypair — skip npub/bunker prompts]'
      ;;
    seed)
      _arguments \\
        '--events[Number of events to publish]:count:' \\
        '--full[Also publish profile, contact list, and reactions]'
      ;;
    relay)
      case $words[3] in
        config)
          _arguments \\
            '--auth[Toggle NIP-42 auth]:value:(on off)' \\
            '--dm-auth[Toggle DM auth restriction]:value:(on off)'
          ;;
        whitelist)
          _arguments \\
            '--add[Add an npub to whitelist]:npub:' \\
            '--remove[Remove an npub from whitelist]:npub:'
          ;;
        *)
          _describe 'relay subcommand' relay_cmds
          ;;
      esac
      ;;
    keychain)
      case $words[3] in
        get|set|delete|rotate)
          _describe 'credential key' keychain_keys
          ;;
        *)
          _describe 'keychain subcommand' keychain_cmds
          ;;
      esac
      ;;
    nsite)
      _describe 'nsite subcommand' nsite_cmds
      ;;
    push)
      _arguments \\
        '--github[Push to GitHub remote only]' \\
        '--ngit[Push to ngit remote only]'
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

  local commands="onboard doctor status update logs relay tui seed push keychain nsite setup-editor uninstall completion version"

  case $prev in
    nostr-station)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return ;;
    relay)
      COMPREPLY=($(compgen -W "start stop restart status config whitelist" -- "$cur"))
      return ;;
    config)
      if [[ \${words[2]} == "relay" ]]; then
        COMPREPLY=($(compgen -W "--auth --dm-auth" -- "$cur"))
        return
      fi ;;
    whitelist)
      if [[ \${words[2]} == "relay" ]]; then
        COMPREPLY=($(compgen -W "--add --remove" -- "$cur"))
        return
      fi ;;
    keychain)
      COMPREPLY=($(compgen -W "list get set delete rotate migrate" -- "$cur"))
      return ;;
    get|set|delete|rotate)
      if [[ \${words[1]} == "keychain" ]]; then
        COMPREPLY=($(compgen -W "ai-api-key watchdog-nsec" -- "$cur"))
        return
      fi ;;
    onboard)
      COMPREPLY=($(compgen -W "--demo" -- "$cur"))
      return ;;
    seed)
      COMPREPLY=($(compgen -W "--events --full" -- "$cur"))
      return ;;
    push)
      COMPREPLY=($(compgen -W "--github --ngit" -- "$cur"))
      return ;;
    nsite)
      COMPREPLY=($(compgen -W "init publish deploy status open help" -- "$cur"))
      return ;;
    --service)
      COMPREPLY=($(compgen -W "relay watchdog all" -- "$cur"))
      return ;;
    --auth|--dm-auth)
      COMPREPLY=($(compgen -W "on off" -- "$cur"))
      return ;;
  esac

  case \${words[1]} in
    doctor)
      COMPREPLY=($(compgen -W "--fix --repair --deep" -- "$cur")) ;;
    update)
      COMPREPLY=($(compgen -W "--dry-run --yes --wizard" -- "$cur")) ;;
    logs)
      COMPREPLY=($(compgen -W "--follow -f --service" -- "$cur")) ;;
    push)
      COMPREPLY=($(compgen -W "--github --ngit" -- "$cur")) ;;
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
