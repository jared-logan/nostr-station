import fs from 'fs';
import os from 'os';
import path from 'path';

// Durable log for the onboard Install phase. When a step blows up (notably
// the ngit cargo compile on fresh Mint boxes), the user can't catch the
// failure fast enough in the scrolling TUI — `~/logs/install.log` gives
// them a post-mortem they can cat and paste into a bug report.
//
// Matches the pattern already used by installNostrVpn (src/lib/install.ts)
// for its own log; we deliberately keep nvpn-install.log separate so the
// multi-step sudo/download trace stays scoped to that function.

export interface InstallLog {
  /** Absolute path of the log file — surfaced in error UI. */
  path: string;
  /** Append one line. Prepends an ISO-8601 timestamp. Best-effort; write
   *  failures are swallowed so a broken disk doesn't take down onboard. */
  append: (line: string) => void;
}

export function openInstallLog(file = 'install.log'): InstallLog {
  const logPath = path.join(os.homedir(), 'logs', file);
  const append = (line: string): void => {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, stamped + '\n');
    } catch {
      /* best-effort — the log is diagnostic, not load-bearing */
    }
  };
  return { path: logPath, append };
}
