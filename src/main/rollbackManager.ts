import { existsSync, mkdirSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PCDOCTOR_ROOT } from './constants.js';
import { runPowerShellScript } from './scriptRunner.js';
import { createRollbackRow, getRollback, markRollbackReverted, pruneExpiredRollbacks } from './dataStore.js';
import type { ActionDefinition } from '@shared/actions.js';

const SNAPSHOTS_DIR = path.join(PCDOCTOR_ROOT, 'snapshots');
const DEFAULT_RETENTION_DAYS = 30;

interface SnapshotManifest {
  rollback_id: number;
  created_at: number;
  action_name: string;
  paths: { source: string; snapshot: string }[];
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
    const description = action.restore_point_description ?? `PCDoctor: ${action.label}`;
    let seq: number | null = null;
    try {
      const result = await runPowerShellScript<{ sequence_number?: number }>(
        'actions/Create-RestorePoint.ps1',
        ['-Description', description],
      );
      seq = typeof result.sequence_number === 'number' ? result.sequence_number : null;
    } catch {
      // If restore point creation fails (common without admin), still record the rollback
      // with only a label — the Revert button will inform the user it's unavailable.
    }
    return createRollbackRow({
      label: `Pre: ${action.label}`,
      windows_rp_seq: seq ?? undefined,
      action_id: actionId,
      expires_at: expiresAt,
    });
  }

  // Tier B — file snapshot
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

  const paths = action.snapshot_paths ?? [];
  for (const srcPath of paths) {
    if (!existsSync(srcPath)) continue;
    const base = path.basename(srcPath);
    const destPath = path.join(snapshotDir, 'files', base);
    mkdirSync(path.dirname(destPath), { recursive: true });
    try {
      cpSync(srcPath, destPath, { recursive: true });
      manifest.paths.push({ source: srcPath, snapshot: destPath });
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

/** Helper — writes snapshot_path to an existing rollback row. */
function updateRollbackSnapshotPath(id: number, snapshotPath: string) {
  // We avoid circular deps by doing this via dataStore in a small patch.
  // For simplicity, use a direct SQL via the shared db connection.
  // This function should be moved to dataStore if used more than here.
  const Database = require('better-sqlite3') as typeof import('better-sqlite3');
  const { WORKBENCH_DB_PATH } = require('./constants.js');
  const conn = new Database.default(WORKBENCH_DB_PATH);
  try {
    conn.prepare(`UPDATE rollbacks SET snapshot_path = ? WHERE id = ?`).run(snapshotPath, id);
  } finally {
    conn.close();
  }
}

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
    let restored = 0;
    for (const p of manifest.paths) {
      try {
        cpSync(p.snapshot, p.source, { recursive: true, force: true });
        restored++;
      } catch {
        // Continue with others
      }
    }
    markRollbackReverted(rollbackId);
    return { method: 'file-snapshot', reboot_required: false, files_restored: restored };
  }

  return { method: 'none', reboot_required: false, reason: 'No recoverable rollback payload' };
}

/** Periodic cleanup — called daily. */
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
