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

CREATE TABLE IF NOT EXISTS persistence_baseline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  identifier TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  path TEXT,
  publisher TEXT,
  signed INTEGER,
  details_json TEXT,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  approved INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_persistence_identifier ON persistence_baseline(identifier);

CREATE TABLE IF NOT EXISTS security_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  scanner TEXT NOT NULL,
  duration_ms INTEGER,
  threats_found INTEGER DEFAULT 0,
  threats_json TEXT,
  status TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_security_scans_ts ON security_scans(ts);

CREATE TABLE IF NOT EXISTS workbench_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  channel TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_ok INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS seen_findings (
  hash TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  notified INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weekly_review_states (
  review_date TEXT NOT NULL,
  item_id TEXT NOT NULL,
  state TEXT NOT NULL,
  state_changed_at INTEGER NOT NULL,
  applied_action_id INTEGER,
  notes TEXT,
  PRIMARY KEY (review_date, item_id)
);

CREATE TABLE IF NOT EXISTS tool_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  tool_id TEXT NOT NULL,
  csv_path TEXT,
  samples INTEGER,
  findings_json TEXT,
  summary TEXT
);
CREATE INDEX IF NOT EXISTS idx_tool_results_ts ON tool_results(ts);

-- ============== AUTOPILOT (v2.2.0) ==============
CREATE TABLE IF NOT EXISTS autopilot_rules (
  id TEXT PRIMARY KEY,              -- stable rule id (e.g. 'empty_recycle_bins_weekly')
  tier INTEGER NOT NULL,            -- 1 | 2 | 3
  description TEXT NOT NULL,
  trigger TEXT NOT NULL,            -- 'schedule' | 'threshold'
  cadence TEXT,                     -- 'weekly:sun:03:00' or NULL for threshold
  action_name TEXT,                 -- ActionName for tier 1/2
  alert_json TEXT,                  -- JSON for tier 3 alert metadata
  enabled INTEGER NOT NULL DEFAULT 1,
  suppressed_until INTEGER,         -- when non-null, rule sleeps until this ts
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS autopilot_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  rule_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  action_name TEXT,
  outcome TEXT NOT NULL,            -- 'auto_run' | 'alerted' | 'suppressed' | 'skipped' | 'error'
  bytes_freed INTEGER,
  duration_ms INTEGER,
  message TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_autopilot_activity_ts ON autopilot_activity(ts);
CREATE INDEX IF NOT EXISTS idx_autopilot_activity_rule ON autopilot_activity(rule_id, ts);
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

/** Set the rollback_id on an existing actions_log row. */
export function updateActionLogRollbackId(actionLogId: number, rollbackId: number) {
  openDb().prepare(`UPDATE actions_log SET rollback_id = ? WHERE id = ?`).run(rollbackId, actionLogId);
}

/** Set the snapshot_path on an existing rollbacks row. */
export function updateRollbackSnapshotPath(rollbackId: number, snapshotPath: string) {
  openDb().prepare(`UPDATE rollbacks SET snapshot_path = ? WHERE id = ?`).run(snapshotPath, rollbackId);
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
  // Wipe previous forecasts - we want the latest set only
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

// ============== PERSISTENCE BASELINE ==============

export interface PersistenceRow {
  id: number;
  kind: string;
  identifier: string;
  name: string;
  path: string | null;
  publisher: string | null;
  signed: number | null;
  details_json: string | null;
  first_seen: number;
  last_seen: number;
  approved: number;
}

export function upsertPersistence(item: {
  kind: string; identifier: string; name: string;
  path?: string; publisher?: string; signed?: boolean;
  details?: unknown;
}): { is_new: boolean; row: PersistenceRow } {
  const db = openDb();
  const now = Date.now();
  const existing = db.prepare(`SELECT * FROM persistence_baseline WHERE identifier = ?`).get(item.identifier) as PersistenceRow | undefined;
  if (existing) {
    db.prepare(`UPDATE persistence_baseline SET last_seen = ? WHERE identifier = ?`).run(now, item.identifier);
    return { is_new: false, row: { ...existing, last_seen: now } };
  }
  const info = db.prepare(
    `INSERT INTO persistence_baseline (kind, identifier, name, path, publisher, signed, details_json, first_seen, last_seen, approved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).run(
    item.kind, item.identifier, item.name,
    item.path ?? null, item.publisher ?? null, item.signed === undefined ? null : (item.signed ? 1 : 0),
    item.details ? JSON.stringify(item.details) : null,
    now, now
  );
  return { is_new: true, row: {
    id: Number(info.lastInsertRowid), kind: item.kind, identifier: item.identifier, name: item.name,
    path: item.path ?? null, publisher: item.publisher ?? null, signed: item.signed === undefined ? null : (item.signed ? 1 : 0),
    details_json: item.details ? JSON.stringify(item.details) : null, first_seen: now, last_seen: now, approved: 0,
  }};
}

export function listPersistenceItems(days = 30): PersistenceRow[] {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  return openDb().prepare(
    `SELECT * FROM persistence_baseline WHERE last_seen >= ? ORDER BY first_seen DESC`
  ).all(since) as PersistenceRow[];
}

export function setPersistenceApproval(identifier: string, approved: -1 | 0 | 1): void {
  openDb().prepare(`UPDATE persistence_baseline SET approved = ? WHERE identifier = ?`).run(approved, identifier);
}

export function countNewPersistence(hours = 24): number {
  const since = Date.now() - hours * 60 * 60 * 1000;
  const row = openDb().prepare(
    `SELECT COUNT(*) as c FROM persistence_baseline WHERE first_seen >= ? AND approved = 0`
  ).get(since) as { c: number };
  return row?.c ?? 0;
}

export function recordSecurityScan(r: {
  scanner: string; duration_ms: number; threats_found?: number; threats?: unknown; status: string;
}): number {
  const info = openDb().prepare(
    `INSERT INTO security_scans (ts, scanner, duration_ms, threats_found, threats_json, status) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(), r.scanner, r.duration_ms,
    r.threats_found ?? 0, r.threats ? JSON.stringify(r.threats) : null, r.status
  );
  return Number(info.lastInsertRowid);
}

// ============== SETTINGS ==============

export function getSetting(key: string): string | null {
  const row = openDb().prepare(`SELECT value FROM workbench_settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
  openDb().prepare(
    `INSERT INTO workbench_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(key, value, Date.now());
}

export function getAllSettings(): Record<string, string> {
  const rows = openDb().prepare(`SELECT key, value FROM workbench_settings`).all() as Array<{ key: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// ============== NOTIFICATIONS ==============

export function recordNotification(n: { channel: string; severity: string; title: string; body: string; sent_ok: boolean; error?: string }): void {
  openDb().prepare(
    `INSERT INTO notification_log (ts, channel, severity, title, body, sent_ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), n.channel, n.severity, n.title, n.body, n.sent_ok ? 1 : 0, n.error ?? null);
}

export function hasSeenFinding(hash: string): boolean {
  const row = openDb().prepare(`SELECT hash FROM seen_findings WHERE hash = ?`).get(hash);
  return !!row;
}

export function markFindingSeen(hash: string, notified = false): void {
  const now = Date.now();
  openDb().prepare(
    `INSERT INTO seen_findings (hash, first_seen, last_seen, notified) VALUES (?, ?, ?, ?)
     ON CONFLICT(hash) DO UPDATE SET last_seen = excluded.last_seen, notified = CASE WHEN seen_findings.notified = 1 THEN 1 ELSE excluded.notified END`
  ).run(hash, now, now, notified ? 1 : 0);
}

export function getMetricWeekDelta(category: string, metric: string, label?: string): { week_ago: number | null; now: number | null } {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const tolerance = 2 * 24 * 60 * 60 * 1000;  // find the closest point within 2 days of a week ago

  const nowRow = openDb().prepare(
    `SELECT value FROM metrics WHERE category = ? AND metric = ? ${label ? 'AND label = ?' : ''} ORDER BY ts DESC LIMIT 1`
  ).get(...(label ? [category, metric, label] : [category, metric])) as { value: number } | undefined;

  const weekRow = openDb().prepare(
    `SELECT value FROM metrics WHERE category = ? AND metric = ? ${label ? 'AND label = ?' : ''} AND ts BETWEEN ? AND ? ORDER BY ABS(ts - ?) ASC LIMIT 1`
  ).get(...(label ? [category, metric, label, weekAgo - tolerance, weekAgo + tolerance, weekAgo] : [category, metric, weekAgo - tolerance, weekAgo + tolerance, weekAgo])) as { value: number } | undefined;

  return {
    week_ago: weekRow?.value ?? null,
    now: nowRow?.value ?? null,
  };
}

// ============== WEEKLY REVIEW STATES ==============

export type ReviewItemState = 'pending' | 'applied' | 'dismissed' | 'snoozed' | 'auto_resolved';

export function setReviewItemState(reviewDate: string, itemId: string, state: ReviewItemState, appliedActionId?: number): void {
  openDb().prepare(
    `INSERT INTO weekly_review_states (review_date, item_id, state, state_changed_at, applied_action_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(review_date, item_id) DO UPDATE SET
       state = excluded.state,
       state_changed_at = excluded.state_changed_at,
       applied_action_id = excluded.applied_action_id`
  ).run(reviewDate, itemId, state, Date.now(), appliedActionId ?? null);
}

export function getReviewItemStates(reviewDate: string): Record<string, { state: ReviewItemState; state_changed_at: number; applied_action_id: number | null }> {
  const rows = openDb().prepare(
    `SELECT item_id, state, state_changed_at, applied_action_id FROM weekly_review_states WHERE review_date = ?`
  ).all(reviewDate) as Array<{ item_id: string; state: ReviewItemState; state_changed_at: number; applied_action_id: number | null }>;
  const out: Record<string, { state: ReviewItemState; state_changed_at: number; applied_action_id: number | null }> = {};
  for (const r of rows) out[r.item_id] = { state: r.state, state_changed_at: r.state_changed_at, applied_action_id: r.applied_action_id };
  return out;
}

export function closeDb() {
  db?.close();
  db = null;
}

// ============== TOOL RESULTS ==============

export interface ToolResultRow {
  id: number;
  ts: number;
  tool_id: string;
  csv_path: string | null;
  samples: number | null;
  findings_json: string | null;
  summary: string | null;
}

export function insertToolResult(row: {
  tool_id: string; csv_path?: string; samples?: number; findings?: unknown; summary?: string;
}): number {
  const info = openDb().prepare(
    `INSERT INTO tool_results (ts, tool_id, csv_path, samples, findings_json, summary) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(), row.tool_id, row.csv_path ?? null, row.samples ?? null,
    row.findings ? JSON.stringify(row.findings) : null, row.summary ?? null
  );
  return Number(info.lastInsertRowid);
}

export function listToolResults(toolId?: string, limit = 20): ToolResultRow[] {
  const sql = toolId
    ? `SELECT * FROM tool_results WHERE tool_id = ? ORDER BY ts DESC LIMIT ?`
    : `SELECT * FROM tool_results ORDER BY ts DESC LIMIT ?`;
  const params = toolId ? [toolId, limit] : [limit];
  return openDb().prepare(sql).all(...params) as ToolResultRow[];
}

// ============== AUTOPILOT RULES + ACTIVITY (v2.2.0) ==============

export interface AutopilotRuleRow {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence: string | null;
  action_name: string | null;
  alert_json: string | null;
  enabled: number;
  suppressed_until: number | null;
  updated_at: number;
}

export function upsertAutopilotRule(rule: {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence?: string | null;
  action_name?: string | null;
  alert_json?: string | null;
  enabled?: boolean;
}): void {
  openDb().prepare(
    `INSERT INTO autopilot_rules (id, tier, description, trigger, cadence, action_name, alert_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       tier = excluded.tier,
       description = excluded.description,
       trigger = excluded.trigger,
       cadence = excluded.cadence,
       action_name = excluded.action_name,
       alert_json = excluded.alert_json,
       updated_at = excluded.updated_at`
  ).run(
    rule.id,
    rule.tier,
    rule.description,
    rule.trigger,
    rule.cadence ?? null,
    rule.action_name ?? null,
    rule.alert_json ?? null,
    rule.enabled === false ? 0 : 1,
    Date.now(),
  );
}

export function listAutopilotRules(): AutopilotRuleRow[] {
  return openDb().prepare(
    `SELECT * FROM autopilot_rules ORDER BY tier ASC, id ASC`
  ).all() as AutopilotRuleRow[];
}

export function suppressAutopilotRule(ruleId: string, untilTs: number): void {
  openDb().prepare(
    `UPDATE autopilot_rules SET suppressed_until = ?, updated_at = ? WHERE id = ?`
  ).run(untilTs, Date.now(), ruleId);
}

/**
 * v2.3.0 C2: persist an enabled/disabled toggle from the Autopilot Rules tab.
 * autopilotEngine.evaluateAutopilot() already filters by enabled=1.
 */
export function setAutopilotRuleEnabled(ruleId: string, enabled: boolean): void {
  openDb().prepare(
    `UPDATE autopilot_rules SET enabled = ?, updated_at = ? WHERE id = ?`
  ).run(enabled ? 1 : 0, Date.now(), ruleId);
}

export function getAutopilotRule(ruleId: string): AutopilotRuleRow | null {
  const row = openDb().prepare(`SELECT * FROM autopilot_rules WHERE id = ?`).get(ruleId) as AutopilotRuleRow | undefined;
  return row ?? null;
}

export interface AutopilotActivityRow {
  id: number;
  ts: number;
  rule_id: string;
  tier: number;
  action_name: string | null;
  outcome: string;
  bytes_freed: number | null;
  duration_ms: number | null;
  message: string | null;
  details_json: string | null;
}

export function insertAutopilotActivity(row: {
  rule_id: string;
  tier: 1 | 2 | 3;
  action_name?: string | null;
  outcome: 'auto_run' | 'alerted' | 'suppressed' | 'skipped' | 'error';
  bytes_freed?: number;
  duration_ms?: number;
  message?: string;
  details?: unknown;
}): number {
  const info = openDb().prepare(
    `INSERT INTO autopilot_activity (ts, rule_id, tier, action_name, outcome, bytes_freed, duration_ms, message, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    Date.now(),
    row.rule_id,
    row.tier,
    row.action_name ?? null,
    row.outcome,
    row.bytes_freed ?? null,
    row.duration_ms ?? null,
    row.message ?? null,
    row.details ? JSON.stringify(row.details) : null,
  );
  return Number(info.lastInsertRowid);
}

export function listAutopilotActivity(daysBack = 30, limit = 500): AutopilotActivityRow[] {
  const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  return openDb().prepare(
    `SELECT * FROM autopilot_activity WHERE ts >= ? ORDER BY ts DESC LIMIT ?`
  ).all(since, limit) as AutopilotActivityRow[];
}

/** Most recent auto_run or alerted entry for a rule. Used to rate-limit scheduled evaluations. */
export function getLastAutopilotActivity(ruleId: string): AutopilotActivityRow | null {
  const row = openDb().prepare(
    `SELECT * FROM autopilot_activity WHERE rule_id = ? ORDER BY ts DESC LIMIT 1`
  ).get(ruleId) as AutopilotActivityRow | undefined;
  return row ?? null;
}

/** Count how many times a rule's action failed in the last N days. */
export function countAutopilotFailures(ruleId: string, daysBack = 7): number {
  const since = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const row = openDb().prepare(
    `SELECT COUNT(*) as c FROM autopilot_activity WHERE rule_id = ? AND outcome = 'error' AND ts >= ?`
  ).get(ruleId, since) as { c: number };
  return row?.c ?? 0;
}
