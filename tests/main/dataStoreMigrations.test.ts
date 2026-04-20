// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';

/**
 * v2.3.13 schema migration framework (dataStore.ts:176-206, S20).
 *
 * Invariants under test (mirroring runMigrations verbatim):
 *   1. On a fresh DB, user_version pragma starts at 0.
 *   2. A migration with version > current is applied in-order; user_version
 *      is updated inside the same transaction as the migration body.
 *   3. Running the same migration list a SECOND time does nothing
 *      (idempotent across restarts - reviewer S20 explicit goal).
 *   4. Migrations are applied in ascending version order regardless of
 *      order in the MIGRATIONS array (i.e. sorted by .version).
 *   5. If a migration throws, user_version is NOT bumped (transaction
 *      rolls back). This is the "partial apply = bad" safety net.
 *
 * We inline a minimal copy of runMigrations (it isn't exported from
 * dataStore). The point is to lock the contract of the framework, not
 * to test better-sqlite3 itself.
 */

interface Migration { version: number; name: string; up: (db: Database.Database) => void; }

function runMigrations(db: Database.Database, MIGRATIONS: Migration[]) {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    const tx = db.transaction(() => {
      m.up(db);
      db.pragma(`user_version = ${m.version}`);
    });
    tx();
  }
}

describe('dataStore migration framework (S20)', () => {
  let tempDir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-mig-test-'));
    dbPath = path.join(tempDir, 'workbench.db');
    db = new Database(dbPath);
    // Mirror dataStore.openDb() pragmas so tests match prod shape.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    try { db.close(); } catch {}
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('fresh DB reports user_version = 0', () => {
    const v = db.pragma('user_version', { simple: true });
    expect(v).toBe(0);
  });

  it('applies a migration in-order and bumps user_version in the same transaction', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'add_mig_test_table',
        up: (d) => d.exec(`CREATE TABLE mig_test (id INTEGER PRIMARY KEY, val TEXT)`),
      },
    ];
    runMigrations(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    // The table exists.
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mig_test'`).get();
    expect(row).toBeDefined();
  });

  it('is idempotent: running the same migration list twice does not re-apply', () => {
    let applyCount = 0;
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'create_a',
        up: (d) => { applyCount++; d.exec(`CREATE TABLE a (id INTEGER PRIMARY KEY)`); },
      },
    ];
    runMigrations(db, migrations);
    expect(applyCount).toBe(1);
    runMigrations(db, migrations);
    expect(applyCount).toBe(1);   // still 1 -> no re-apply
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });

  it('is idempotent across reopens: close + re-open + re-run leaves user_version unchanged', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'create_b',
        up: (d) => d.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY)`),
      },
    ];
    runMigrations(db, migrations);
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    db.close();

    // "Restart": open the same file again.
    const db2 = new Database(dbPath);
    db2.pragma('journal_mode = WAL');
    let secondApplyCount = 0;
    runMigrations(db2, [
      {
        version: 1,
        name: 'create_b',
        up: (d) => { secondApplyCount++; d.exec(`CREATE TABLE b (id INTEGER PRIMARY KEY)`); },
      },
    ]);
    expect(secondApplyCount).toBe(0);
    expect(db2.pragma('user_version', { simple: true })).toBe(1);
    db2.close();
    db = new Database(dbPath);   // let afterEach clean it up
  });

  it('applies migrations in ascending version order even when the array is unsorted', () => {
    const order: number[] = [];
    const migrations: Migration[] = [
      { version: 3, name: 'm3', up: (d) => { order.push(3); d.exec(`CREATE TABLE m3 (id INT)`); } },
      { version: 1, name: 'm1', up: (d) => { order.push(1); d.exec(`CREATE TABLE m1 (id INT)`); } },
      { version: 2, name: 'm2', up: (d) => { order.push(2); d.exec(`CREATE TABLE m2 (id INT)`); } },
    ];
    runMigrations(db, migrations);
    expect(order).toEqual([1, 2, 3]);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });

  it('applies only migrations newer than current user_version', () => {
    // Simulate a DB that was already at user_version = 2.
    db.pragma('user_version = 2');
    const applied: number[] = [];
    const migrations: Migration[] = [
      { version: 1, name: 'm1', up: () => { applied.push(1); } },
      { version: 2, name: 'm2', up: () => { applied.push(2); } },
      { version: 3, name: 'm3', up: (d) => { applied.push(3); d.exec(`CREATE TABLE m3x (id INT)`); } },
    ];
    runMigrations(db, migrations);
    expect(applied).toEqual([3]);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });

  it('rolls back a failing migration: user_version stays, DDL is not persisted', () => {
    const migrations: Migration[] = [
      {
        version: 1,
        name: 'good',
        up: (d) => d.exec(`CREATE TABLE good (id INTEGER PRIMARY KEY)`),
      },
      {
        version: 2,
        name: 'bad',
        up: (d) => {
          d.exec(`CREATE TABLE bad_table (id INTEGER PRIMARY KEY)`);
          throw new Error('simulated migration failure');
        },
      },
    ];
    expect(() => runMigrations(db, migrations)).toThrow(/simulated migration failure/);
    // user_version should be at 1 (the good migration committed), not 2.
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    // bad_table must NOT exist (rolled back with the transaction).
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='bad_table'`).get();
    expect(row).toBeUndefined();
    // good DID commit.
    const good = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='good'`).get();
    expect(good).toBeDefined();
  });
});

/**
 * Smoke test: opening the real dataStore module against a temp path should
 * NOT throw, and should leave user_version at >= 0 regardless of the number
 * of migrations declared. This catches regressions where runMigrations()
 * is accidentally called before db.exec(SCHEMA), or where MIGRATIONS is
 * mis-declared (e.g. duplicate versions).
 */
describe('dataStore.openDb() boot smoke test', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-mig-smoke-'));
    dbPath = path.join(tempDir, 'workbench.db');
    (globalThis as any).__TEST_DB_PATH__ = dbPath;
    vi.resetModules();
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  it('opens, runs migrations, and reports a numeric user_version', async () => {
    vi.doMock('../../src/main/constants.js', () => ({
      get WORKBENCH_DB_PATH() { return (globalThis as any).__TEST_DB_PATH__; },
      PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
      LATEST_JSON_PATH: 'C:\\ProgramData\\PCDoctor\\reports\\latest.json',
      LOG_DIR: 'C:\\ProgramData\\PCDoctor\\logs',
      resolvePwshPath: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      PWSH_FALLBACK: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      DEFAULT_SCRIPT_TIMEOUT_MS: 300_000,
      AUTOSTART_TASK_NAME: 'PCDoctor-Workbench-Autostart',
      POLL_INTERVAL_MS: 60_000,
    }));
    const ds = await import('../../src/main/dataStore.js');
    // Trigger openDb by doing any read; e.g. getSetting returns null without throwing.
    expect(ds.getSetting('__nonexistent__')).toBeNull();
    // Reopen the raw file to check user_version was set.
    const raw = new Database(dbPath);
    const v = raw.pragma('user_version', { simple: true });
    expect(typeof v).toBe('number');
    raw.close();
    try { ds.closeDb(); } catch {}
  });
});
