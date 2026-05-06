import os from 'os';
import fs from 'fs';
import path from 'path';

// Shell completion for nostr-station.
//
// After `nostr-station completion --shell zsh --install` (or bash),
// `nostr-station <TAB>` in your terminal shows available commands +
// per-subcommand flags. Standard CLI convention; makes the tool feel
// native.
//
// The command list and flag set here mirror src/cli.tsx — keep them in
// sync when adding/removing verbs. The dashboard verbs (start, up,
// chat, serve) all do the same thing; we expose them all so users can
// type whichever feels natural.

const NSITE_SUBCOMMANDS    = ['init', 'publish', 'deploy', 'status', 'open', 'help'];
const KEYCHAIN_SUBCOMMANDS = ['list', 'get', 'set', 'delete', 'rotate', 'migrate'];
const KEYCHAIN_KEYS        = ['ai-api-key', 'watchdog-nsec', 'seed-nsec'];
const AI_SUBCOMMANDS       = ['list', 'add', 'remove', 'default'];

const ZSH_COMPLETION = `#compdef nostr-station

_nostr_station() {
  local -a commands
  commands=(
    'start:Start the dashboard (alias: up, chat, serve)'
    'up:Start the dashboard'
    'chat:Start the dashboard'
    'serve:Start the dashboard'
    'stop:Stop the running dashboard (alias: down)'
    'down:Stop the running dashboard'
    'status:Show relay and service status'
    'seed:Seed relay with dummy events for testing'
    'keychain:Manage credentials in the OS keychain'
    'ai:Manage AI provider configuration'
    'add:Install an optional tool (ngit, nak, stacks, nsyte)'
    'list:List optional tools (alias of: add)'
    'publish:Publish to all configured remotes (git + ngit)'
    'nsite:Manage nsite publishing (nsyte)'
    'editor:Link NOSTR_STATION.md to your AI coding tool'
    'completion:Generate shell completion'
    'version:Print version'
  )

  local -a keychain_cmds keychain_keys nsite_cmds ai_cmds
  keychain_cmds=(${KEYCHAIN_SUBCOMMANDS.map(c => `'${c}'`).join(' ')})
  keychain_keys=(${KEYCHAIN_KEYS.map(c => `'${c}'`).join(' ')})
  nsite_cmds=(${NSITE_SUBCOMMANDS.map(c => `'${c}'`).join(' ')})
  ai_cmds=(${AI_SUBCOMMANDS.map(c => `'${c}'`).join(' ')})

  case $words[2] in
    seed)
      _arguments \\
        '--events[Number of events to publish]:count:' \\
        '--full[Also publish profile, contact list, and reactions]'
      ;;
    status)
      _arguments \\
        '--json[Emit machine-readable JSON instead of TUI]'
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
    ai)
      _describe 'ai subcommand' ai_cmds
      ;;
    nsite)
      _describe 'nsite subcommand' nsite_cmds
      ;;
    publish)
      _arguments \\
        '--github[Publish to GitHub remote only]' \\
        '--ngit[Publish to ngit remote only]'
      ;;
    completion)
      _arguments \\
        '--shell[Shell to target]:shell:(zsh bash)' \\
        '--install[Write completion script to disk]'
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

  local commands="start up chat serve stop down status seed keychain ai add list publish nsite editor completion version"

  case $prev in
    nostr-station)
      COMPREPLY=($(compgen -W "$commands" -- "$cur"))
      return ;;
    keychain)
      COMPREPLY=($(compgen -W "${KEYCHAIN_SUBCOMMANDS.join(' ')}" -- "$cur"))
      return ;;
    get|set|delete|rotate)
      if [[ \${words[1]} == "keychain" ]]; then
        COMPREPLY=($(compgen -W "${KEYCHAIN_KEYS.join(' ')}" -- "$cur"))
        return
      fi ;;
    ai)
      COMPREPLY=($(compgen -W "${AI_SUBCOMMANDS.join(' ')}" -- "$cur"))
      return ;;
    nsite)
      COMPREPLY=($(compgen -W "${NSITE_SUBCOMMANDS.join(' ')}" -- "$cur"))
      return ;;
    seed)
      COMPREPLY=($(compgen -W "--events --full" -- "$cur"))
      return ;;
    publish)
      COMPREPLY=($(compgen -W "--github --ngit" -- "$cur"))
      return ;;
    completion)
      COMPREPLY=($(compgen -W "--shell --install" -- "$cur"))
      return ;;
    --shell)
      COMPREPLY=($(compgen -W "zsh bash" -- "$cur"))
      return ;;
  esac

  case \${words[1]} in
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
