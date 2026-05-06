/**
 * Path-safety guard for project-scoped AI tools.
 *
 * Every fs / exec tool receives an `input` path string from the LLM.
 * Without sanitization the model can — accidentally or via prompt
 * injection — read /etc/passwd, write to ~/.ssh/authorized_keys, or
 * delete arbitrary files via `..` traversal. This module is the one
 * place that translates "untrusted client-supplied path" → "safe
 * absolute path inside project root."
 *
 * Rules (all enforced; any failure → reject):
 *
 *   1. Path must not contain a NUL byte (defends against C-layer
 *      truncation attacks on dependents that fall through to native
 *      syscalls).
 *   2. Path must not be absolute (`/etc/passwd`, `C:\...`, `~/foo`).
 *      Tools take project-relative paths only.
 *   3. After path.resolve(project.path, input), the resolved path
 *      must be the project root or a descendant. We use
 *      path.relative() and reject when the result starts with `..`
 *      (anchored: the `startsWith(root + sep)` check has bugs on
 *      directories like /home/jared vs /home/jared-evil — see the
 *      same defense in projects.ts:resolveSafeAbsolute).
 *   4. If the resolved path exists, fs.realpathSync is called to
 *      canonicalize symlinks. Same in-root check applied to the
 *      realpath. Rejects symlinks pointing outside the project.
 *   5. If the resolved path doesn't exist yet (e.g. write_file to a
 *      brand-new path), we walk up to the longest existing ancestor
 *      and realpath THAT. Rejects parent-symlink escapes.
 *
 * Returns { ok: true, abs } on success; { ok: false, error } on any
 * rejection. Callers should never pass `abs` back to the LLM in
 * error messages — log it server-side, show the LLM the user-facing
 * `error` string only.
 */

import fs from 'fs';
import path from 'path';
import type { Project } from '../projects.js';

export interface SafeResult {
  ok:    boolean;
  abs?:  string;
  error?: string;
}

export function resolveProjectPath(project: Project, input: string): SafeResult {
  // Guard: project must have a writable root.
  if (!project.path) {
    return { ok: false, error: 'project has no local path' };
  }
  if (typeof input !== 'string') {
    return { ok: false, error: 'path must be a string' };
  }
  // Treat empty / "." / "./" as the project root itself — common
  // for list_dir({}) at the top level.
  const normalizedInput = input === '' ? '.' : input;

  // Reject NUL bytes outright.
  if (normalizedInput.indexOf('\0') !== -1) {
    return { ok: false, error: 'path contains a null byte' };
  }

  // Reject absolute paths (UNIX `/foo`, Windows `C:\` or `\\?\`,
  // tilde-expansion is also user-shell territory). The tool contract
  // is project-relative paths only.
  if (path.isAbsolute(normalizedInput)) {
    return { ok: false, error: 'path must be project-relative (no absolute paths)' };
  }
  // Reject explicit `~` segments — neither bash-style home expansion
  // nor a literal `~` directory name should be valid input here.
  if (/(^|[\\/])~([\\/]|$)/.test(normalizedInput)) {
    return { ok: false, error: 'path must not contain ~ segments' };
  }

  // Resolve relative to project.path.
  const resolved = path.resolve(project.path, normalizedInput);
  if (!isInside(project.path, resolved)) {
    return { ok: false, error: 'path resolves outside the project root' };
  }

  // Symlink check: realpath the longest existing ancestor (so write
  // tools that target a not-yet-existing file are still gated by
  // the realpath of the deepest existing dir).
  let existing = resolved;
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break; // hit the filesystem root
    existing = parent;
  }
  let real: string;
  try {
    real = fs.realpathSync(existing);
  } catch {
    // realpath can fail if the path becomes inaccessible mid-walk;
    // treat as a soft reject so we never silently fall back to a
    // potentially escape-y resolved path.
    return { ok: false, error: 'path could not be canonicalized' };
  }

  // Realpath of the existing prefix must still be inside the project
  // root (after realpath of the project root itself for symmetry).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(project.path);
  } catch {
    realRoot = project.path; // root missing is a separate error class; let callers handle.
  }
  if (!isInside(realRoot, real) && real !== realRoot) {
    return { ok: false, error: 'path resolves outside the project root (symlink escape)' };
  }
  // The unresolved tail (resolved minus existing) must still land
  // inside realRoot once we re-attach it. path.resolve(real, tail)
  // collapses any further `..` segments.
  const tail = path.relative(existing, resolved);
  const finalAbs = path.resolve(real, tail);
  if (!isInside(realRoot, finalAbs) && finalAbs !== realRoot) {
    return { ok: false, error: 'path resolves outside the project root' };
  }

  return { ok: true, abs: finalAbs };
}

function isInside(root: string, child: string): boolean {
  if (root === child) return true;
  const rel = path.relative(root, child);
  if (rel === '') return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}
