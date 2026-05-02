import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PCDOCTOR_ROOT } from './constants.js';
import { getSetting, setSetting } from './dataStore.js';

/**
 * v2.4.6: NAS configuration (server IP + drive mappings) moves out of
 * hardcoded PowerShell constants into the settings table. The scanner
 * and Remap-NAS action can't reach SQLite, so we sync a sidecar JSON
 * file at `C:\ProgramData\PCDoctor\settings\nas.json` on every app
 * startup (and whenever the user edits the settings).
 *
 * The JSON is the single source of truth for PS consumers. If the file
 * is missing (fresh install), they fall back to the defaults below,
 * which match the pre-v2.4.6 hardcoded values to keep upgrades silent.
 */

/**
 * v2.6.0 (public branch): defaults are empty so fresh installs start
 * clean. The first-run wizard (or Settings page) populates these from
 * auto-detected network drives. Existing installs that already wrote
 * nas_server / nas_mappings to the DB are unaffected — readNasConfig()
 * reads the DB first and only falls back to these when no DB value exists.
 */
export const DEFAULT_NAS_SERVER = '';

export interface NasMapping {
  /** Drive letter with trailing colon, e.g. "M:" */
  drive: string;
  /** SMB share name, e.g. "Plex Movies" (used as \\{server}\{share}) */
  share: string;
}

export const DEFAULT_NAS_MAPPINGS: NasMapping[] = [];

const NAS_CONFIG_DIR = path.join(PCDOCTOR_ROOT, 'settings');
const NAS_CONFIG_FILE = path.join(NAS_CONFIG_DIR, 'nas.json');

export interface NasConfig {
  nas_server: string;
  nas_mappings: NasMapping[];
  /** Sidecar version tag so PS consumers can detect schema changes. */
  schema_version: number;
  /** When the file was last written, epoch ms. For debugging. */
  updated_at: number;
}

/**
 * Pull NAS settings from the DB, falling back to defaults for any
 * missing values. Lightweight — no side effects.
 */
export function readNasConfig(): NasConfig {
  const server = getSetting('nas_server') || DEFAULT_NAS_SERVER;
  const rawMappings = getSetting('nas_mappings');
  let mappings: NasMapping[] = DEFAULT_NAS_MAPPINGS;
  if (rawMappings) {
    try {
      const parsed = JSON.parse(rawMappings);
      if (Array.isArray(parsed) && parsed.every(isValidMapping)) {
        mappings = parsed;
      }
    } catch { /* keep defaults on malformed JSON */ }
  }
  return {
    nas_server: server,
    nas_mappings: mappings,
    schema_version: 1,
    updated_at: Date.now(),
  };
}

function isValidMapping(x: unknown): x is NasMapping {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.drive === 'string' && /^[A-Z]:$/.test(o.drive)
    && typeof o.share === 'string' && o.share.length > 0;
}

/**
 * Persist config back to DB and mirror it to the sidecar JSON file.
 * Used by the Settings page save handler. Validates mappings before
 * accepting them; throws on bad input.
 */
export function writeNasConfig(server: string, mappings: NasMapping[]): void {
  if (typeof server !== 'string') {
    throw new Error('nas_server must be a string');
  }
  // v2.4.10: restrict server to hostname / IPv4-shaped chars.
  // This value flows into `\\$server\$share` via Remap-NAS.ps1 → New-PSDrive.
  // Without validation, `..\`, `"; rm`, or embedded backslashes could escape
  // the intended UNC path or inject PowerShell. Allow only letters, digits,
  // dots, hyphens, underscores — covers IPv4 (192.168.1.1), NetBIOS names
  // (QNAP-01), and FQDNs (nas.local).
  if (!/^[A-Za-z0-9._-]+$/.test(server)) {
    throw new Error('nas_server must contain only letters, digits, dots, hyphens, and underscores (hostname or IPv4)');
  }
  if (!Array.isArray(mappings)) {
    throw new Error('nas_mappings must be an array');
  }
  for (const m of mappings) {
    if (!isValidMapping(m)) {
      throw new Error(`Invalid mapping: ${JSON.stringify(m)}. Expected {drive:"X:", share:"..."}`);
    }
  }
  setSetting('nas_server', server);
  setSetting('nas_mappings', JSON.stringify(mappings));
  syncNasConfigToDisk();
}

/**
 * Write (or overwrite) the sidecar JSON at
 * `C:\ProgramData\PCDoctor\settings\nas.json`. Scanner + action
 * scripts read this file. Silent no-op if the target directory can't
 * be created (shouldn't happen on a normal install).
 */
export function syncNasConfigToDisk(): void {
  try {
    if (!existsSync(NAS_CONFIG_DIR)) {
      mkdirSync(NAS_CONFIG_DIR, { recursive: true });
    }
    const config = readNasConfig();
    writeFileSync(NAS_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
  } catch {
    // Non-fatal. Scanner falls back to hardcoded defaults.
  }
}

export { NAS_CONFIG_FILE };
