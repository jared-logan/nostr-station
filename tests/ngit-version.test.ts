import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  parseNgitHelp,
  parseNgitVersion,
  hasSubcommand,
} = await import('../src/lib/ngit-version.ts');

// ── parseNgitVersion ──────────────────────────────────────────────────────

test('parseNgitVersion: standard `<bin> <semver>` output', () => {
  assert.equal(parseNgitVersion('ngit 2.4.3\n'),    '2.4.3');
  assert.equal(parseNgitVersion('ngit-cli 1.0.0'),  '1.0.0');
});

test('parseNgitVersion: pre-release tag preserved', () => {
  assert.equal(parseNgitVersion('ngit 2.5.0-rc.1'), '2.5.0-rc.1');
  assert.equal(parseNgitVersion('ngit 2.5.0-beta'), '2.5.0-beta');
});

test('parseNgitVersion: returns null on no version-shaped substring', () => {
  assert.equal(parseNgitVersion(''),           null);
  assert.equal(parseNgitVersion('just text'),  null);
  // 1.0 is not full semver — we require MAJOR.MINOR.PATCH.
  assert.equal(parseNgitVersion('ngit 1.0'),   null);
});

// ── parseNgitHelp: clap v4 ("Commands:" section, blank-line terminator) ───

test('parseNgitHelp: clap v4 layout', () => {
  // Synthetic help output mirroring `ngit --help` from a recent ngit
  // build. The Commands section is followed by a blank line and then
  // an Options section, which must NOT be picked up.
  const help = `\
A nostr git CLI

Usage: ngit [OPTIONS] <COMMAND>

Commands:
  init             Publish or refresh a kind 30617
  send             Submit a PR
  list             List patches and PRs
  pr_merge         Merge a PR
  issue_create     Open an issue
  issue_status     Set issue status
  comment          Post a NIP-22 comment
  help             Print this message or the help of the given subcommand(s)

Options:
  -h, --help    Print help
  -V, --version Print version
`;
  const subs = parseNgitHelp(help);
  assert.ok(subs.has('init'));
  assert.ok(subs.has('send'));
  assert.ok(subs.has('list'));
  assert.ok(subs.has('pr_merge'));
  assert.ok(subs.has('issue_create'));
  assert.ok(subs.has('issue_status'));
  assert.ok(subs.has('comment'));
  // Filter `help` (every clap binary has it; no signal value).
  assert.equal(subs.has('help'), false);
  // Must NOT include words from the Options section.
  assert.equal(subs.has('h'),    false);
  assert.equal(subs.has('v'),    false);
});

// ── parseNgitHelp: clap v3 ("SUBCOMMANDS:" section, heading terminator) ───

test('parseNgitHelp: clap v3 layout', () => {
  const help = `\
USAGE:
    ngit [OPTIONS] <SUBCOMMAND>

SUBCOMMANDS:
    init        Publish or refresh
    send        Submit a PR
    list        List patches and PRs
    pr_merge    Merge a PR
    help        Print this message or the help of the given subcommand(s)

OPTIONS:
    -h, --help    Print help
`;
  const subs = parseNgitHelp(help);
  assert.deepEqual(
    [...subs].sort(),
    ['init', 'list', 'pr_merge', 'send'],
  );
});

// ── parseNgitHelp: edge cases ─────────────────────────────────────────────

test('parseNgitHelp: empty input → empty set', () => {
  assert.equal(parseNgitHelp('').size, 0);
});

test('parseNgitHelp: no Commands section → empty set', () => {
  // Some builds trip an error before printing help — we'd rather
  // return an empty set than guess.
  const help = 'error: subcommand required\nrun `ngit --help` for usage';
  assert.equal(parseNgitHelp(help).size, 0);
});

test('parseNgitHelp: subcommand-aliases form (parens) still picks the canonical name', () => {
  // clap renders `init        Publish or refresh` for an aliased
  // command as e.g. `init [aliases: i]` — leading word is still the
  // canonical subcommand, which is what we want.
  const help = `\
Commands:
  init [aliases: i]    Publish or refresh
  send                 Submit a PR
`;
  const subs = parseNgitHelp(help);
  assert.deepEqual([...subs].sort(), ['init', 'send']);
});

// ── hasSubcommand ─────────────────────────────────────────────────────────

test('hasSubcommand: false when ngit is not installed', () => {
  // Even if subcommands somehow leaked into the set, an absent binary
  // means the capability is false. Defence-in-depth so a stale cache
  // can't cause "Merge" to render against a missing tool.
  const caps = {
    installed:   false,
    binPath:     null,
    version:     null,
    subcommands: new Set(['pr_merge']),
    probeError:  null,
  };
  assert.equal(hasSubcommand(caps, 'pr_merge'), false);
});

test('hasSubcommand: case-insensitive match', () => {
  const caps = {
    installed:   true,
    binPath:     '/usr/bin/ngit',
    version:     '2.4.3',
    subcommands: new Set(['pr_merge', 'issue_create']),
    probeError:  null,
  };
  assert.equal(hasSubcommand(caps, 'PR_MERGE'),   true);
  assert.equal(hasSubcommand(caps, 'issue_create'), true);
  assert.equal(hasSubcommand(caps, 'send'),       false);
});
