import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { WORKBENCH_DB_PATH } from './constants.js';
import type { ActionName } from '@shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics(ts);
CREATE INDEX IF NOT EXISTS idx_metrics_cat_metric ON metrics(category, metric, ts);

CREATE TABLE IF NOT EXISTS actions_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  action_name TEXT NOT NULL,
  action_label TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  result_json TEXT,
  error_message TEXT,
  rollback_id INTEGER,
  reverted_at INTEGER,
  triggered_by TEXT NOT NULL DEFAULT 'user',
  params_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions_log(ts);

CREATE TABLE IF NOT EXISTS rollbacks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  label TEXT NOT NULL,
  windows_rp_seq INTEGER,
  snapshot_path TEXT,
  action_id INTEGER,
  expires_at INTEGER NOT NULL,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_rollbacks_ts ON rollbacks(ts);

CREATE TABLE IF NOT EXISTS forecasts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at INTEGER NOT NULL,
  metric TEXT NOT NULL,
  projection_json TEXT NOT NULL,
  preventive_action TEXT,
  due_date INTEGER
);
CREATE INDEX IF NOT EXISTS idx_forecasts_ts ON forecasts(generated_at);
`;

let db: Database.Database | null = null;

function openDb(): Database.Database {
  if (db) return db;
  const dir = path.dirname(WORKBENCH_DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new Database(WORKBENCH_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  return db;
}

// ============== ACTIONS LOG ==============

export interface ActionLogInsert {
  action_name: ActionName;
  action_label: string;
  status: 'running' | 'success' | 'error';
  triggered_by?: 'user' | 'scheduled' | 'telegram' | 'alert';
  params?: Record<string, unknown>;
  rollback_id?: number;
}

export function startActionLog(entry: ActionLogInsert): number {
  const stmt = openDb().prepare(
    `INSERT INTO actions_log (ts, action_name, action_label, status, triggered_by, params_json, rollback_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(
    Date.now(),
    entry.action_name,
    entry.action_label,
    entry.status,
    entry.triggered_by ?? 'user',
    entry.params ? JSON.stringify(entry.params) : null,
    entry.rollback_id ?? null,
  );
  return Number(info.lastInsertRowid);
}

export function finishActionLog(
  id: number,
  outcome: { status: 'success' | 'error'; duration_ms: number; result?: unknown; error_message?: string },
) {
  const stmt = openDb().prepare(
    `UPDATE actions_log SET status = ?, duration_ms = ?, result_json = ?, error_message = ? WHERE id = ?`,
  );
  stmt.run(
    outcome.status,
    outcome.duration_ms,
    outcome.result ? JSON.stringify(outcome.result) : null,
    outcome.error_message ?? null,
    id,
  );
}

export function markActionReverted(id: number) {
  openDb().prepare(`UPDATE actions_log SET reverted_at = ? WHERE id = ?`).run(Date.now(), id);
}

export interface ActionLogRow {
  id: number;
  ts: number;
  action_name: string;
  action_label: string;
  status: string;
  duration_ms: number | null;
  result_json: string | null;
  error_message: string | null;
  rollback_id: number | null;
  reverted_at: number | null;
  triggered_by: string;
  params_json: string | null;
}

export function listActionLog(limit = 200): ActionLogRow[] {
  return openDb().prepare(
    `SELECT * FROM actions_log ORDER BY ts DESC LIMIT ?`,
  ).all(limit) as ActionLogRow[];
}

// ============== ROLLBACKS ==============

export interface RollbackInsert {
  label: string;
  windows_rp_seq?: number;
  snapshot_path?: string;
  action_id?: number;
  expires_at: number;
}

export function createRollbackRow(r: RollbackInsert): number {
  const info = openDb().prepare(
    `INSERT INTO rollbacks (ts, label, windows_rp_seq, snapshot_path, action_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    Date.now(), r.label, r.windows_rp_seq ?? null, r.snapshot_path ?? null,
    r.action_id ?? null, r.expires_at,
  );
  return Number(info.lastInsertRowid);
}

export interface RollbackRow {
  id: number; ts: number; label: string;
  windows_rp_seq: number | null; snapshot_path: string | null;
  action_id: number | null; expires_at: number; reverted_at: number | null;
}

export function getRollback(id: number): RollbackRow | null {
  return openDb().prepare(`SELECT * FROM rollbacks WHERE id = ?`).get(id) as RollbackRow | null;
}

export function markRollbackReverted(id: number) {
  openDb().prepare(`UPDATE rollbacks SET reverted_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function pruneExpiredRollbacks(): number {
  const info = openDb().prepare(`DELETE FROM rollbacks WHERE expires_at < ?`).run(Date.now());
  return Number(info.changes);
}

// ============== METRICS ==============

export interface MetricPoint { ts: number; value: number; }

export function insertMetric(category: string, metric: string, value: number, label?: string): void {
  openDb().prepare(
    `INSERT INTO metrics (ts, category, metric, value, label) VALUES (?, ?, ?, ?, ?)`
  ).run(Date.now(), category, metric, value, label ?? null);
}

/** Return points for `category.metric` in last N days (oldest first). */
export function queryMetricTrend(category: string, metric: string, days: number): MetricPoint[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return openDb().prepare(
    `SELECT ts, value FROM metrics WHERE category = ? AND metric = ? AND ts >= ? ORDER BY ts ASC`
  ).all(category, metric, since) as MetricPoint[];
}

/** Insert a snapshot of the current system status into metrics table. Idempotent per timestamp. */
export function recordStatusSnapshot(s: {
  cpu_load_pct?: number;
  ram_used_pct?: number;
  disks?: Array<{ drive: string; free_pct: number }>;
  event_errors_system?: number;
  event_errors_application?: number;
}): void {
  const ts = Date.now();
  const stmt = openDb().prepare(
    `INSERT INTO metrics (ts, category, metric, value, label) VALUES (?, ?, ?, ?, ?)`
  );
  if (typeof s.cpu_load_pct === 'number') stmt.run(ts, 'cpu', 'load_pct', s.cpu_load_pct, null);
  if (typeof s.ram_used_pct === 'number') stmt.run(ts, 'ram', 'used_pct', s.ram_used_pct, null);
  if (Array.isArray(s.disks)) {
    for (const d of s.disks) {
      if (typeof d.free_pct === 'number') stmt.run(ts, 'disk', 'free_pct', d.free_pct, d.drive);
    }
  }
  if (typeof s.event_errors_system === 'number') stmt.run(ts, 'events', 'system_count', s.event_errors_system, null);
  if (typeof s.event_errors_application === 'number') stmt.run(ts, 'events', 'application_count', s.event_errors_application, null);
}

// ============== FORECASTS ==============

export function saveForecasts(data: { generated_at: number; projections: any[] }): void {
  const db = openDb();
  // Wipe previous forecasts — we want the latest set only
  db.prepare(`DELETE FROM forecasts`).run();
  const stmt = db.prepare(
    `INSERT INTO forecasts (generated_at, metric, projection_json, preventive_action, due_date) VALUES (?, ?, ?, ?, ?)`
  );
  for (const p of data.projections) {
    const dueMs = p.projected_critical_date ? Date.parse(p.projected_critical_date) : null;
    stmt.run(data.generated_at * 1000, p.metric, JSON.stringify(p), p.preventive_action?.action_name ?? null, dueMs);
  }
}

export function loadForecasts(): { generated_at: number; projections: any[] } | null {
  const db = openDb();
  const rows = db.prepare(`SELECT generated_at, projection_json FROM forecasts ORDER BY generated_at DESC`).all() as Array<{ generated_at: number; projection_json: string }>;
  if (rows.length === 0) return null;
  return {
    generated_at: Math.floor(rows[0].generated_at / 1000),
    projections: rows.map(r => JSON.parse(r.projection_json)),
  };
}

export function closeDb() {
  db?.close();
  db = null;
}
