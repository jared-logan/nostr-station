/**
 * Communities feature gate — opt-in flag + first-use acknowledgement.
 *
 * Communities is shipped behind an explicit experimental gate. The
 * sidebar entry, home card, and Config section all stay HIDDEN until
 * the user enables the feature in Config → Experimental. On first
 * enable, a modal walks through the trade-offs (what mesh members
 * can / can't reach, deployment-scenario recommendations) and
 * requires explicit acknowledgement before any UI surfaces.
 *
 * Two flags are persisted:
 *   - `enabled`           — user has flipped the toggle on (off by default)
 *   - `acknowledgedAt`    — ms epoch of when the user clicked through
 *                            the first-use modal. null until they have.
 *
 * Persisted to ~/.nostr-station/communities-feature.json. Lazy path
 * resolution so tests overriding $HOME work properly (this is the
 * same pattern mobile-access.ts settled on).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function configDir(): string  { return path.join(os.homedir(), '.nostr-station'); }
function configFile(): string { return path.join(configDir(), 'communities-feature.json'); }

export interface CommunitiesFeatureConfig {
  /** Sidebar / home card / Config section visible? Default false. */
  enabled: boolean;
  /** ms epoch of first-use acknowledgement; null until the user has
   *  clicked through the experimental-status modal. */
  acknowledgedAt: number | null;
  /** ms epoch of the last enable/disable change. For diagnostics. */
  updatedAt?: number;
}

const DEFAULT: CommunitiesFeatureConfig = {
  enabled:        false,
  acknowledgedAt: null,
};

export function readCommunitiesFeatureConfig(): CommunitiesFeatureConfig {
  try {
    const f = configFile();
    if (!fs.existsSync(f)) return { ...DEFAULT };
    const raw = fs.readFileSync(f, 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT };
    return {
      enabled:        parsed.enabled === true,
      acknowledgedAt: typeof parsed.acknowledgedAt === 'number' ? parsed.acknowledgedAt : null,
      updatedAt:      typeof parsed.updatedAt === 'number' ? parsed.updatedAt : undefined,
    };
  } catch {
    return { ...DEFAULT };
  }
}

export function writeCommunitiesFeatureConfig(
  cfg: Partial<CommunitiesFeatureConfig>,
): CommunitiesFeatureConfig {
  const current = readCommunitiesFeatureConfig();
  // Defensive coercion: only accept strict booleans / numbers / null.
  // Anything else falls back to the current value. The route layer
  // validates upstream, but stricter-than-needed-here means a
  // direct-from-Node call (e.g. tests, future scripts) can't poison
  // the on-disk file with a string like "yes" that would surprise
  // every consumer downstream.
  const next: CommunitiesFeatureConfig = {
    enabled:        typeof cfg.enabled === 'boolean' ? cfg.enabled : current.enabled,
    acknowledgedAt: typeof cfg.acknowledgedAt === 'number'
                    ? cfg.acknowledgedAt
                    : cfg.acknowledgedAt === null
                      ? null
                      : current.acknowledgedAt,
    updatedAt:      Date.now(),
  };
  try { fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 }); } catch {}
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/** True when the user has both enabled the feature AND clicked through
 *  the first-use acknowledgement modal. The dashboard uses this to
 *  decide whether to render the Communities surface; the routes use
 *  this to refuse mutating endpoints with a 403 before consent. */
export function isCommunitiesUsable(): boolean {
  const cfg = readCommunitiesFeatureConfig();
  return cfg.enabled && cfg.acknowledgedAt !== null;
}
