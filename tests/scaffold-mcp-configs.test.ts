// Verifies new local-only projects ship MCP config files for AI agents
// (Claude Code, opencode, VS Code) wired to nostrbook + js-dev. The
// scaffold module reads them from src/scaffold-assets/mcp-configs/ in
// dev/test and from dist/scaffold-assets/mcp-configs/ in production —
// same relative path either way.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeMcpConfigs, copyNoriIcon, maybeInstallDeps } from '../src/lib/project-scaffold.js';

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ns-scaffold-mcp-'));
}

// Minimal ServerResponse stand-in that captures the SSE frames written by
// the scaffold streamers. maybeInstallDeps only calls res.write(); we parse
// the `data: {…}` payloads back into objects so tests can assert on them.
function makeFakeRes(): { frames: any[]; res: any } {
  const frames: any[] = [];
  const res = {
    write(chunk: string) {
      const m = String(chunk).match(/^data: (.*)\n\n$/s);
      if (m) { try { frames.push(JSON.parse(m[1])); } catch {} }
      return true;
    },
    end() {},
  };
  return { frames, res };
}

test('writeMcpConfigs: drops the three MCP files into target', () => {
  const dir = makeTempProject();
  writeMcpConfigs(dir);
  assert.ok(fs.existsSync(path.join(dir, '.mcp.json')),       '.mcp.json missing');
  assert.ok(fs.existsSync(path.join(dir, 'opencode.json')),   'opencode.json missing');
  assert.ok(fs.existsSync(path.join(dir, '.vscode', 'mcp.json')), '.vscode/mcp.json missing');
});

test('writeMcpConfigs: .mcp.json wires nostrbook + js-dev for Claude Code', () => {
  const dir = makeTempProject();
  writeMcpConfigs(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
  assert.ok(cfg.mcpServers,                'mcpServers key missing');
  assert.ok(cfg.mcpServers.nostr,          'nostr server missing');
  assert.ok(cfg.mcpServers['js-dev'],      'js-dev server missing');
  assert.deepEqual(cfg.mcpServers.nostr.args,
    ['-y', '@nostrbook/mcp@latest'],
    'nostr server should invoke @nostrbook/mcp@latest');
});

test('writeMcpConfigs: opencode.json points at nostrbook', () => {
  const dir = makeTempProject();
  writeMcpConfigs(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
  assert.ok(cfg.mcp?.nostr,                'nostr MCP entry missing');
  assert.deepEqual(cfg.mcp.nostr.command,
    ['npx', '-y', '@nostrbook/mcp@latest'],
    'opencode nostr command should run @nostrbook/mcp@latest');
});

test('writeMcpConfigs: .vscode/mcp.json wires both servers', () => {
  const dir = makeTempProject();
  writeMcpConfigs(dir);
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, '.vscode', 'mcp.json'), 'utf8'));
  assert.ok(cfg.servers,             'servers key missing');
  assert.ok(cfg.servers.nostr,       'nostr server missing');
  assert.ok(cfg.servers['js-dev'],   'js-dev server missing');
});

test('writeMcpConfigs: idempotent — running twice does not throw', () => {
  const dir = makeTempProject();
  writeMcpConfigs(dir);
  writeMcpConfigs(dir);
  // Sanity check: file still parses after the second pass.
  JSON.parse(fs.readFileSync(path.join(dir, '.mcp.json'), 'utf8'));
});

// ── Nori icon pre-seed (MKStack footer asset) ────────────────────────────

test('copyNoriIcon: drops nori.svg into public/ and reports success', () => {
  const dir = makeTempProject();
  const ok = copyNoriIcon(dir);
  assert.equal(ok, true, 'expected copyNoriIcon to succeed');
  const dest = path.join(dir, 'public', 'nori.svg');
  assert.ok(fs.existsSync(dest), 'public/nori.svg missing');
  // The SVG asset should be non-empty and start with the XML/SVG prolog.
  const raw = fs.readFileSync(dest, 'utf8');
  assert.ok(raw.length > 0, 'nori.svg is empty');
  assert.match(raw.slice(0, 200), /<svg/i, 'nori.svg does not look like SVG');
});

test('copyNoriIcon: creates public/ when it does not exist', () => {
  const dir = makeTempProject();
  assert.equal(fs.existsSync(path.join(dir, 'public')), false, 'precondition failed');
  copyNoriIcon(dir);
  assert.ok(fs.existsSync(path.join(dir, 'public')), 'public/ should have been created');
});

test('copyNoriIcon: idempotent — second call overwrites cleanly', () => {
  const dir = makeTempProject();
  assert.equal(copyNoriIcon(dir), true);
  assert.equal(copyNoriIcon(dir), true);
  // Sanity check: file still parses as SVG after the second pass.
  const raw = fs.readFileSync(path.join(dir, 'public', 'nori.svg'), 'utf8');
  assert.match(raw.slice(0, 200), /<svg/i);
});

// ── maybeInstallDeps gate (auto-install scaffolded Node projects) ─────────

test('maybeInstallDeps: no package.json → no-op (no npm spawn, no frames)', async () => {
  const dir = makeTempProject();
  assert.equal(fs.existsSync(path.join(dir, 'package.json')), false, 'precondition');
  const { frames, res } = makeFakeRes();
  await maybeInstallDeps(dir, res);
  // A blank local-only project must not trigger npm install — zero frames.
  assert.equal(frames.length, 0, `expected no frames, got ${JSON.stringify(frames)}`);
});

test('maybeInstallDeps: package.json present → runs npm install and streams the step', async () => {
  const dir = makeTempProject();
  // A package.json with no dependencies installs near-instantly and offline,
  // so the test stays deterministic without reaching the network.
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'ns-install-test', version: '1.0.0', private: true }),
    'utf8',
  );
  const { frames, res } = makeFakeRes();
  await maybeInstallDeps(dir, res);
  // The "Installing dependencies…" announce frame is always written when a
  // package.json is present, regardless of how npm exits.
  const announced = frames.some(f =>
    f.stream === 'sys' && /Installing dependencies/.test(f.line || ''));
  assert.ok(announced, `expected an "Installing dependencies" sys frame, got ${JSON.stringify(frames)}`);
  // npm should have actually run to completion here (empty deps, offline-ok).
  const installed = frames.some(f =>
    f.stream === 'sys' && /Dependencies installed/.test(f.line || ''));
  assert.ok(installed, `expected a success frame, got ${JSON.stringify(frames)}`);
});
