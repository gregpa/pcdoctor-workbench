import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PCDOCTOR_ROOT } from './constants.js';
import { getSetting, setSetting } from './dataStore.js';

/**
 * v2.4.13: Startup-health tuning. Scanner's "healthy under 20" rule
 * used to be hardcoded (and buggy - code compared against 25 while the
 * message said 20). Users with legitimately high startup counts
 * (intentional services like nzbget, cloud sync) need:
 *   - A threshold they can raise so the alert matches their reality.
 *   - An allowlist so specific entries don't contribute to the warning
 *     count even if the threshold is kept low.
 *
 * Same sidecar pattern as nasConfig.ts: mirror settings into
 * C:\ProgramData\PCDoctor\settings\startup.json so Invoke-PCDoctor.ps1
 * can read them without touching SQLite.
 */

export const DEFAULT_STARTUP_THRESHOLD = 20;
export const MIN_STARTUP_THRESHOLD = 5;
export const MAX_STARTUP_THRESHOLD = 200;

/**
 * Allowlist key shape: "<kind>::<name>" matching the id format the UI
 * uses in StartupPickerModal. Kind is one of 'Run' | 'HKLM_Run' |
 * 'StartupFolder' (see StartupItemMetric).
 */
export interface StartupConfig {
  threshold: number;
  allowlist: string[];
  schema_version: number;
  updated_at: number;
}

const STARTUP_CONFIG_DIR = path.join(PCDOCTOR_ROOT, 'settings');
const STARTUP_CONFIG_FILE = path.join(STARTUP_CONFIG_DIR, 'startup.json');

export function readStartupConfig(): StartupConfig {
  const rawThreshold = getSetting('startup_threshold');
  let threshold = DEFAULT_STARTUP_THRESHOLD;
  if (rawThreshold) {
    const n = parseInt(rawThreshold, 10);
    if (Number.isInteger(n) && n >= MIN_STARTUP_THRESHOLD && n <= MAX_STARTUP_THRESHOLD) {
      threshold = n;
    }
  }
  const rawAllowlist = getSetting('startup_allowlist');
  let allowlist: string[] = [];
  if (rawAllowlist) {
    try {
      const parsed = JSON.parse(rawAllowlist);
      if (Array.isArray(parsed)) {
        allowlist = parsed.filter((x): x is string =>
          typeof x === 'string' && x.length > 0 && x.length <= 500,
        );
      }
    } catch { /* keep empty on malformed JSON */ }
  }
  // v2.4.13 (W2 fix): updated_at reflects the last user save, not the
  // current moment. Stored as a string-epoch-ms setting next to the
  // threshold + allowlist; if absent (pre-v2.4.13 upgrade or default
  // read), fall back to Date.now() so consumers still see a valid
  // timestamp rather than 0.
  let updatedAt = Date.now();
  const rawUpdatedAt = getSetting('startup_updated_at');
  if (rawUpdatedAt) {
    const n = Number(rawUpdatedAt);
    if (Number.isFinite(n) && n > 0) updatedAt = n;
  }
  return {
    threshold,
    allowlist,
    schema_version: 1,
    updated_at: updatedAt,
  };
}

/**
 * Validate + persist to DB + mirror to sidecar JSON. Throws on invalid
 * input so the IPC layer returns a clean E_VALIDATION error instead of
 * silently dropping the write.
 */
export function writeStartupConfig(threshold: number, allowlist: string[]): void {
  if (!Number.isInteger(threshold) || threshold < MIN_STARTUP_THRESHOLD || threshold > MAX_STARTUP_THRESHOLD) {
    throw new Error(`threshold must be an integer between ${MIN_STARTUP_THRESHOLD} and ${MAX_STARTUP_THRESHOLD}`);
  }
  if (!Array.isArray(allowlist)) {
    throw new Error('allowlist must be an array of strings');
  }
  for (const k of allowlist) {
    if (typeof k !== 'string' || k.length === 0 || k.length > 500) {
      throw new Error(`Invalid allowlist entry: ${JSON.stringify(k)}. Expected non-empty string up to 500 chars.`);
    }
  }
  const dedup = Array.from(new Set(allowlist));
  setSetting('startup_threshold', String(threshold));
  setSetting('startup_allowlist', JSON.stringify(dedup));
  // v2.4.13 (W2 fix): stamp the user-save timestamp so readStartupConfig
  // can return the TRUE last-save time instead of Date.now() on every read.
  setSetting('startup_updated_at', String(Date.now()));
  syncStartupConfigToDisk();
}

/**
 * Overwrite the sidecar JSON at
 * C:\ProgramData\PCDoctor\settings\startup.json. Invoke-PCDoctor.ps1
 * reads this file at scan time. Non-fatal on error - scanner falls back
 * to default threshold + empty allowlist.
 */
export function syncStartupConfigToDisk(): void {
  try {
    if (!existsSync(STARTUP_CONFIG_DIR)) {
      mkdirSync(STARTUP_CONFIG_DIR, { recursive: true });
    }
    const cfg = readStartupConfig();
    writeFileSync(STARTUP_CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

export { STARTUP_CONFIG_FILE };
