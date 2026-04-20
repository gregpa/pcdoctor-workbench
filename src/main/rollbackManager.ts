import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { PCDOCTOR_ROOT } from './constants.js';
import { runPowerShellScript } from './scriptRunner.js';
import { createRollbackRow, getRollback, markRollbackReverted, pruneExpiredRollbacks, updateRollbackSnapshotPath } from './dataStore.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionDefinition } from '@shared/actions.js';

const SNAPSHOTS_DIR = path.join(PCDOCTOR_ROOT, 'snapshots');
const DEFAULT_RETENTION_DAYS = 30;
const MIN_SNAPSHOT_FREE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB safety floor

interface SnapshotManifest {
  rollback_id: number;
  created_at: number;
  action_name: string;
  paths: { source: string; snapshot: string; sha256?: string }[];
}

/**
 * Hash a file (Tier B integrity check on revert) or a directory (manifest
 * of relative path + sha256 of each file, hashed again).
 */
function hashPath(p: string): string | null {
  try {
    const st = statSync(p);
    if (st.isFile()) {
      return createHash('sha256').update(readFileSync(p)).digest('hex');
    }
    if (st.isDirectory()) {
      const { readdirSync } = require('node:fs');
      const entries: string[] = [];
      const walk = (dir: string, rel: string) => {
        const list = readdirSync(dir, { withFileTypes: true });
        for (const e of list) {
          const full = path.join(dir, e.name);
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(full, r);
          else if (e.isFile()) {
            const h = createHash('sha256').update(readFileSync(full)).digest('hex');
            entries.push(`${r}\t${h}`);
          }
        }
      };
      walk(p, '');
      entries.sort();
      return createHash('sha256').update(entries.join('\n')).digest('hex');
    }
  } catch {}
  return null;
}

/** Encode a source path into a collision-free snapshot dirname. */
function encodeSnapshotName(srcPath: string): string {
  // Hash the full path so two sources with the same basename don't collide
  // (reviewer P1 - previous basename-only code was an architectural landmine).
  // Short hash is fine; collision space is one action's paths.
  const short = createHash('sha256').update(srcPath).digest('hex').slice(0, 12);
  const safeBase = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  return `${safeBase}-${short}`;
}

/**
 * Prepare a rollback before running a destructive action.
 * Returns rollback_id if a rollback was set up; null for Tier C/none.
 */
export async function prepareRollback(
  action: ActionDefinition,
  actionId: number,
): Promise<number | null> {
  if (action.rollback_tier === 'none' || action.rollback_tier === 'C') {
    return null;
  }

  const expiresAt = Date.now() + DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  if (action.rollback_tier === 'A') {
    // Reviewer P0: previous code inserted a rollback row even when RP
    // creation failed. The UI then displayed a Revert button that, when
    // clicked, found no windows_rp_seq + no snapshot_path and returned
    // method:'none'. That's a fabricated capability. Now: if the restore
    // point can't be created (VSS disabled, SystemRestorePointCreationFrequency
    // throttle, non-admin run), return null so actionRunner records no
    // rollback_id and the UI hides the Revert button. Action still runs.
    const description = action.restore_point_description ?? `PCDoctor: ${action.label}`;
    try {
      const result = await runPowerShellScript<{ sequence_number?: number }>(
        'actions/Create-RestorePoint.ps1',
        ['-Description', description],
      );
      const seq = typeof result.sequence_number === 'number' ? result.sequence_number : null;
      if (seq === null) return null;
      return createRollbackRow({
        label: `Pre: ${action.label}`,
        windows_rp_seq: seq,
        action_id: actionId,
        expires_at: expiresAt,
      });
    } catch (e) {
      console.warn(`prepareRollback: restore point failed for ${action.name}:`, e);
      return null;
    }
  }

  // Tier B - file snapshot
  const rollbackId = createRollbackRow({
    label: `Pre: ${action.label}`,
    action_id: actionId,
    expires_at: expiresAt,
  });

  const snapshotDir = path.join(SNAPSHOTS_DIR, String(rollbackId));
  mkdirSync(snapshotDir, { recursive: true });

  const manifest: SnapshotManifest = {
    rollback_id: rollbackId,
    created_at: Date.now(),
    action_name: action.name,
    paths: [],
  };

  // Disk-space preflight: refuse to even start a Tier B snapshot if the
  // snapshots volume has < 1 GB free. A partial snapshot + destructive
  // action = unrecoverable state.
  try {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
    const fs = await statfs(SNAPSHOTS_DIR);
    const free = Number(fs.bsize) * Number(fs.bavail);
    if (free < MIN_SNAPSHOT_FREE_BYTES) {
      console.warn(`prepareRollback: insufficient snapshot disk space (${free} bytes). Skipping Tier B snapshot for ${action.name}.`);
      // Return null: no rollback row. The Tier B action still runs but is
      // marked non-revertable in the audit log. Wrong > fabricated.
      return null;
    }
  } catch { /* non-fatal; statfs unsupported on some filesystems */ }

  const paths = action.snapshot_paths ?? [];
  for (const srcPath of paths) {
    if (!existsSync(srcPath)) continue;
    // Hash-based dest name: source C:\A\foo.txt and C:\B\foo.txt no longer
    // collide, and the sha256 stored in manifest lets revert verify that the
    // snapshot wasn't swapped out-of-band (reviewer P1 - Tier B integrity).
    const destName = encodeSnapshotName(srcPath);
    const destPath = path.join(snapshotDir, 'files', destName);
    mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      cpSync(srcPath, destPath, { recursive: true });
      const hash = hashPath(destPath) ?? undefined;
      manifest.paths.push({ source: srcPath, snapshot: destPath, sha256: hash });
    } catch {
      // Skip unreadable paths rather than fail the rollback setup
    }
  }

  writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Update rollback with snapshot_path
  const db = getRollback(rollbackId);
  if (db) {
    // Use dataStore's underlying update since we already inserted
    // (small helper so callers don't need to touch SQL)
    updateRollbackSnapshotPath(rollbackId, snapshotDir);
  }

  return rollbackId;
}

// Note: updateRollbackSnapshotPath is now imported from dataStore (above).
// The previous inline "new Database(...)" opened a second connection to the
// WAL-mode DB which raced with the primary and surfaced as SQLITE_READONLY.

export type RevertOutcome =
  | { method: 'system-restore'; reboot_required: true; rp_seq: number }
  | { method: 'file-snapshot'; reboot_required: false; files_restored: number }
  | { method: 'none'; reboot_required: false; reason: string };

/** Revert a previously-logged action. */
export async function revertRollback(rollbackId: number): Promise<RevertOutcome> {
  const rb = getRollback(rollbackId);
  if (!rb) {
    return { method: 'none', reboot_required: false, reason: `Rollback ${rollbackId} not found` };
  }
  if (rb.expires_at < Date.now()) {
    return { method: 'none', reboot_required: false, reason: 'Rollback expired' };
  }
  if (rb.reverted_at) {
    return { method: 'none', reboot_required: false, reason: 'Already reverted' };
  }

  // Tier A: windows_rp_seq present → schedule rstrui
  if (rb.windows_rp_seq !== null && rb.windows_rp_seq !== undefined) {
    // We do NOT auto-launch rstrui; we surface the seq so the UI can instruct the user.
    markRollbackReverted(rollbackId);
    return { method: 'system-restore', reboot_required: true, rp_seq: rb.windows_rp_seq };
  }

  // Tier B: snapshot_path present
  if (rb.snapshot_path && existsSync(rb.snapshot_path)) {
    const manifestPath = path.join(rb.snapshot_path, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { method: 'none', reboot_required: false, reason: 'Manifest missing' };
    }
    const manifest: SnapshotManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    // Validate each source path against the originating action's declared snapshot_paths.
    // This prevents a tampered manifest.json (ProgramData is user-writable on dev systems)
    // from steering cpSync to overwrite arbitrary files.
    const actionDef = ACTIONS[manifest.action_name as keyof typeof ACTIONS];
    const allowedSources = (actionDef?.snapshot_paths ?? []).map(p => path.normalize(p).toLowerCase());

    let restored = 0;
    let rejected = 0;
    for (const p of manifest.paths) {
      const normalizedSource = path.normalize(p.source).toLowerCase();
      const isAllowed = allowedSources.some(a => {
        // Exact match or source is under an allowed directory
        return normalizedSource === a || normalizedSource.startsWith(a + path.sep);
      });
      if (!isAllowed) {
        rejected++;
        continue;
      }
      // Additional safety: refuse to restore to sensitive system roots unless
      // the action's own snapshot_paths explicitly allowlists this exact path
      // (e.g. reset_hosts_file explicitly includes the hosts file path).
      const forbidden = ['c:\\windows\\system32\\drivers\\etc\\hosts', 'c:\\windows', 'c:\\program files'];
      const isSystemPath = forbidden.some(f => normalizedSource === f || normalizedSource.startsWith(f + path.sep));
      const isExplicitlyAllowed = allowedSources.includes(normalizedSource);
      if (isSystemPath && !isExplicitlyAllowed) {
        rejected++;
        continue;
      }
      // Tier B integrity check (reviewer 2.7): if the manifest recorded a
      // sha256 at snapshot time, verify the snapshot payload hasn't been
      // swapped between action-time and revert-time.
      if (p.sha256) {
        const actual = hashPath(p.snapshot);
        if (actual !== p.sha256) {
          console.warn(`revertRollback: snapshot hash mismatch for ${p.source}; skipping restore`);
          rejected++;
          continue;
        }
      }
      try {
        cpSync(p.snapshot, p.source, { recursive: true, force: true });
        restored++;
      } catch {
        // Continue with others
      }
    }
    // Reviewer P1: previously we always markRollbackReverted even when
    // nothing was actually restored. Now we only mark reverted if at least
    // one file came back. If everything was rejected/failed, leave the row
    // unreverted so the user can see an accurate state.
    if (restored === 0) {
      return { method: 'none', reboot_required: false, reason: rejected > 0 ? `Manifest rejected: ${rejected} path(s) not in action allow-list or hash mismatch` : 'No files restored' };
    }
    markRollbackReverted(rollbackId);
    return { method: 'file-snapshot', reboot_required: false, files_restored: restored };
  }

  return { method: 'none', reboot_required: false, reason: 'No recoverable rollback payload' };
}

/** Periodic cleanup - called daily. */
export function pruneExpired(): { removed: number } {
  const removed = pruneExpiredRollbacks();

  // Also delete snapshot directories for rollbacks that no longer have DB rows
  if (existsSync(SNAPSHOTS_DIR)) {
    const { readdirSync, statSync } = require('node:fs');
    for (const entry of readdirSync(SNAPSHOTS_DIR)) {
      const dirPath = path.join(SNAPSHOTS_DIR, entry);
      if (!statSync(dirPath).isDirectory()) continue;
      const id = Number(entry);
      if (Number.isNaN(id)) continue;
      const rb = getRollback(id);
      if (!rb) {
        try { rmSync(dirPath, { recursive: true, force: true }); } catch {}
      }
    }
  }

  return { removed };
}
