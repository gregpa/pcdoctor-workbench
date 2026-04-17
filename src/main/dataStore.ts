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
  triggered_by TEXT NOT NULL DEFAULT 'user'
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions_log(ts);
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

export interface ActionLogInsert {
  action_name: ActionName;
  action_label: string;
  status: 'running' | 'success' | 'error';
  triggered_by?: 'user' | 'scheduled' | 'telegram' | 'alert';
}

export function startActionLog(entry: ActionLogInsert): number {
  const stmt = openDb().prepare(
    `INSERT INTO actions_log (ts, action_name, action_label, status, triggered_by) VALUES (?, ?, ?, ?, ?)`,
  );
  const info = stmt.run(Date.now(), entry.action_name, entry.action_label, entry.status, entry.triggered_by ?? 'user');
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

export function closeDb() {
  db?.close();
  db = null;
}
