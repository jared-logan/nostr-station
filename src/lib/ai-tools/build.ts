// build_project — run the project's build and feed the output back
// to the model. Closes the self-correction loop: when the agent
// writes code and the build fails, it sees the actual compiler /
// type-checker / bundler error and can iterate. Without this tool
// the agent is "writing in the dark" — confident edits with no
// feedback that anything actually compiles.
//
// Mirrors shakespeare.diy's BuildProjectTool, scaled to our setup:
// they compile with esbuild-wasm in-browser; we run the project's
// own build script via spawn (matching how the dashboard's existing
// stacks/deploy + nsite/deploy endpoints already invoke `npm run`
// for project-defined scripts).
//
// Permission: 'gated'. The existing requiresApproval logic
// auto-approves gated tools in auto-edit mode for everything except
// run_command, which is exactly the right line — build is normal
// project workflow, not arbitrary command exec.

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Tool, ToolResult } from './index.js';

const DEFAULT_TIMEOUT_MS = 120_000;       // 2 min — typical small-project build envelope
const MAX_TIMEOUT_MS     = 600_000;       // 10 min ceiling
const MAX_OUTPUT_BYTES   = 32 * 1024;     // per-stream cap for what the model sees

interface BuildSpec {
  command: string;
  argv:    string[];
  reason:  string;
}

// Detect the project's build command from on-disk signals. npm is
// the only family we support today; future work could add cargo,
// just/justfile, makefile detection. Returns null when nothing
// actionable is found so the tool can give the model a clean error
// instead of guessing.
export function detectBuildCommand(projectPath: string): BuildSpec | null {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: any;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch { return null; }
  if (!pkg?.scripts || typeof pkg.scripts !== 'object') return null;
  if (typeof pkg.scripts.build === 'string' && pkg.scripts.build.trim()) {
    return {
      command: 'npm run build',
      argv:    ['npm', 'run', 'build'],
      reason:  'package.json has scripts.build',
    };
  }
  if (typeof pkg.scripts.compile === 'string' && pkg.scripts.compile.trim()) {
    return {
      command: 'npm run compile',
      argv:    ['npm', 'run', 'compile'],
      reason:  'package.json has scripts.compile (no scripts.build found)',
    };
  }
  return null;
}

interface BuildResult {
  command:    string;
  exitCode:   number;
  stdout:     string;
  stderr:     string;
  truncated:  boolean;
  // True when the build was killed by our timeout, distinct from a
  // legitimate non-zero exit. Lets the model distinguish "your build
  // is broken" from "your build is too slow"; without this flag the
  // model sees an unintelligible exit code (typically 143 from
  // SIGTERM, sometimes -1) and may waste a turn debugging working
  // code.
  timedOut:   boolean;
  durationMs: number;
}

// Run the build and capture output, capping per-stream so a
// massively chatty build can't blow the model's context. Truncation
// is end-biased — we keep the LAST N bytes per stream because
// errors typically appear at the bottom of the output (after the
// "compiling…" / progress lines).
function runBuild(spec: BuildSpec, cwd: string, timeoutMs: number): Promise<BuildResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdoutTail = '';
    let stderrTail = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut  = false;

    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env:   { ...process.env, NO_COLOR: '1', TERM: 'dumb', CI: '1' },
    });

    const eat = (chunk: Buffer, which: 'stdout' | 'stderr') => {
      const text = chunk.toString();
      if (which === 'stdout') {
        stdoutBytes += text.length;
        stdoutTail = (stdoutTail + text).slice(-MAX_OUTPUT_BYTES);
        if (stdoutBytes > MAX_OUTPUT_BYTES) truncated = true;
      } else {
        stderrBytes += text.length;
        stderrTail = (stderrTail + text).slice(-MAX_OUTPUT_BYTES);
        if (stderrBytes > MAX_OUTPUT_BYTES) truncated = true;
      }
    };
    child.stdout.on('data', (c) => eat(c, 'stdout'));
    child.stderr.on('data', (c) => eat(c, 'stderr'));

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      // SIGTERM may not land instantly on a stuck process; give it
      // a 2s grace period then SIGKILL so the promise resolves.
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({
        command:    spec.command,
        exitCode:   -1,
        stdout:     stdoutTail,
        stderr:     stderrTail + (stderrTail ? '\n' : '') + `[spawn error: ${e.message}]`,
        truncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        command:    spec.command,
        exitCode:   code ?? -1,
        stdout:     stdoutTail,
        stderr:     stderrTail,
        truncated,
        timedOut,
        durationMs: Date.now() - start,
      });
    });
  });
}

const build_project: Tool = {
  name: 'build_project',
  description:
    'Run the project\'s build (npm run build, falling back to npm run '
    + 'compile) and return { command, exitCode, stdout, stderr } so the '
    + 'agent can read compile/type errors and self-correct. Per-stream '
    + 'output is end-biased capped at 32 KB (errors usually live at the '
    + 'tail). Default 120 s timeout, 600 s ceiling. Refuses if the '
    + 'project has no package.json or no build/compile script — tell '
    + 'the user what build command to use instead.',
  inputSchema: {
    type: 'object',
    properties: {
      timeoutMs: { type: 'number', description: 'Override default 120 000 ms; capped at 600 000.' },
    },
    additionalProperties: false,
  },
  permission: 'gated',
  handler: async (args, ctx): Promise<ToolResult> => {
    if (!ctx.project.path) return { ok: false, error: 'project has no local path' };
    const spec = detectBuildCommand(ctx.project.path);
    if (!spec) {
      return {
        ok: false,
        error: 'no build script found — package.json must have either ' +
               '"scripts.build" or "scripts.compile". Add one (or run a ' +
               'custom build via run_command) and retry.',
      };
    }
    const timeoutMs = Number.isInteger(args.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(1000, args.timeoutMs))
      : DEFAULT_TIMEOUT_MS;
    const result = await runBuild(spec, ctx.project.path, timeoutMs);
    const ok = result.exitCode === 0;
    return {
      ok: true,                 // tool ran successfully — exit code communicates build success
      content: {
        ok,                     // build success/failure (separate from tool success)
        ...result,
        reason: spec.reason,
      },
      summary: ok
        ? `built in ${(result.durationMs / 1000).toFixed(1)}s`
        : result.timedOut
          ? `build timed out after ${(result.durationMs / 1000).toFixed(1)}s — pass timeoutMs to extend`
          : `build failed (exit ${result.exitCode}, ${(result.durationMs / 1000).toFixed(1)}s)`,
    };
  },
};

export const TOOLS: Tool[] = [build_project];
