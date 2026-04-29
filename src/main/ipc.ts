import { ipcMain, safeStorage, app, shell } from 'electron';
import { readFile, readdir, unlink, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// v2.4.48 (B48-SEC-1): direct execFile of schtasks.exe with array-form
// args (no shell interpolation). Pre-2.4.48 this helper concatenated
// `['schtasks', ...args].join(' ')` into a powershell.exe -Command string
// at the three callsites that pass renderer-controlled task names. A name
// containing shell metachars (e.g. `'PCDoctor-Foo$(Remove-Item ...)'`)
// would have been parsed and executed by PowerShell. The renderer-side
// allowlist regex below is the primary defence; switching to direct
// execFile is defence-in-depth so a future regex weakening cannot reach
// a shell parser.
//
// Historical Windows-quirk: schtasks.exe hung under direct
// spawn/execFile when invoked via `/Query` WITHOUT `/TN` against a
// machine with a corrupted Microsoft task entry (it expected an
// attached console and timed out). The three callsites here all pass
// `/TN <name>` (Query, Change /ENABLE|/DISABLE, Run) and have NOT been
// observed to hang. If a future regression surfaces the hang we can
// fall back to wrapping in powershell.exe -Command, but each user-
// supplied arg must be emitted as a single-quoted PS literal (mirrors
// scriptRunner.ts:269-279). Do NOT regress to .join(' ').
const pExecFile = promisify(execFile);

// v2.4.48 (B48-SEC-1): allowlist regex extracted to scheduledTaskNames.ts
// so tests/main/ipc.runSchtasksAllowlist.test.ts can import the constant
// without pulling the entire IPC handler module (which transitively
// loads electron-updater + better-sqlite3 -- not loadable from vitest
// node env).
import { SCHEDULED_TASK_NAME_RE } from './scheduledTaskNames.js';
// v2.4.49 (B48-AUDIT-1/2): renderer-supplied reviewDate validator. Extracted
// to a leaf module so tests can import the constant without booting IPC.
import { REVIEW_DATE_RE } from './reviewDateRe.js';

async function runSchtasks(args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string }> {
  return pExecFile(
    'schtasks.exe',
    args,
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }
  );
}
import { getStatus, PCDoctorBridgeError, setCachedSmart } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import { revertRollback } from './rollbackManager.js';
import {
  listActionLog, getActionLogById, markActionReverted, queryMetricTrend, loadForecasts,
  upsertPersistence, setPersistenceApproval, countNewPersistence,
  setSetting, getAllSettings, getSetting,
  setReviewItemState, getReviewItemStates,
  listToolResults,
  getNasRecycleSizes, upsertNasRecycleSize,
} from './dataStore.js';
// v2.4.51 (B51-IPC-3): import the action registry so the rule-import validator
// can enforce action_name ∈ KNOWN_ACTION_NAMES.
import { ACTIONS as ACTIONS_INDEX } from '@shared/actions.js';
import { generateForecasts } from './forecastEngine.js';
import { runPowerShellScript } from './scriptRunner.js';
import { PCDOCTOR_ROOT } from './constants.js';
import { listAllToolStatuses, launchTool, installToolViaWinget, installToolViaDirectDownload } from './toolLauncher.js';
import { TOOLS } from '@shared/tools.js';
import { launchClaudeInTerminal, launchClaudeWithContext, resolveClaudePath } from './claudeBridge.js';
import { checkForUpdates, downloadUpdate, installNow, getStatus as getUpdaterStatus } from './autoUpdater.js';
import type { UpdateStatus } from './autoUpdater.js';
import { testTelegramConnection, sendTelegramMessage } from './telegramBridge.js';
import { flushBufferedNotifications } from './notifier.js';
import { sendWeeklyDigestEmail } from './emailDigest.js';
import { buildClaudeReport, type ClaudeReport } from './claudeReportExporter.js';
import { getAutopilotActivity, evaluateRule, dispatchDecision } from './autopilotEngine.js';
import { listAutopilotRules, suppressAutopilotRule, setAutopilotRuleEnabled, getAutopilotRule, insertAutopilotActivity } from './dataStore.js';
import { writeRenderPerfLine } from './renderPerfLog.js';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, PersistenceItem, ThreatIndicator, ToolStatus, ScheduledTaskInfo,
} from '@shared/types.js';

const weeklyDir = path.join(PCDOCTOR_ROOT, 'reports', 'weekly');

// v2.4.51 (B51-IPC-3): defense-in-depth validation for the renderer-
// controlled api:importAutopilotRules payload. Pre-2.4.51 the handler
// accepted `rules: any[]` and cast `Number(r.tier) as 1|2|3` without
// checking the value. A malformed import (tier 99, unknown action_name,
// 50MB alert_json) wrote garbage into autopilot_rules. Reject early.
const KNOWN_ACTION_NAMES = new Set<string>(Object.keys(ACTIONS_INDEX));
const ALERT_JSON_MAX_BYTES = 4 * 1024;  // 4 KB; live default rules are <500 B each
const VALID_CADENCE_RE = /^(daily:\d{1,2}:\d{2}|weekly:(mon|tue|wed|thu|fri|sat|sun):\d{1,2}:\d{2}|monthly:(\d{1,2}|first|second|third|fourth|last)(sat|sun|mon|tue|wed|thu|fri)?:\d{1,2}:\d{2})$/i;

export interface ValidatedImportedRule {
  id: string;
  tier: 1 | 2 | 3;
  description: string;
  trigger: 'schedule' | 'threshold';
  cadence: string | null;
  action_name: string | null;
  alert_json: string | null;
  enabled: boolean;
}

/**
 * v2.4.51 (B51-IPC-3): validate one imported rule. Returns either
 * { ok: true, rule } with a coerced rule, or { ok: false, reason } with a
 * human-readable rejection reason. Cadence regex is strict — any valid
 * future cadence form must be added here AND to DEFAULT_RULES in
 * autopilotEngine.ts in lockstep so drift is visible.
 */
export function validateImportedRule(raw: unknown): { ok: true; rule: ValidatedImportedRule } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'rule must be an object' };
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 128) return { ok: false, reason: 'invalid id' };
  if (!/^[a-z0-9_-]+$/i.test(r.id)) return { ok: false, reason: 'id must be alnum/underscore/hyphen' };
  const tierNum = Number(r.tier);
  if (tierNum !== 1 && tierNum !== 2 && tierNum !== 3) return { ok: false, reason: 'tier must be 1, 2, or 3' };
  if (typeof r.description !== 'string' || !r.description || r.description.length > 256) return { ok: false, reason: 'invalid description' };
  if (r.trigger !== 'schedule' && r.trigger !== 'threshold') return { ok: false, reason: 'trigger must be schedule|threshold' };
  let cadence: string | null = null;
  if (r.cadence !== null && r.cadence !== undefined) {
    if (typeof r.cadence !== 'string' || r.cadence.length > 64) return { ok: false, reason: 'invalid cadence' };
    if (!VALID_CADENCE_RE.test(r.cadence)) return { ok: false, reason: 'cadence pattern unrecognised' };
    cadence = r.cadence;
  }
  let action_name: string | null = null;
  if (r.action_name !== null && r.action_name !== undefined) {
    if (typeof r.action_name !== 'string') return { ok: false, reason: 'invalid action_name type' };
    if (!KNOWN_ACTION_NAMES.has(r.action_name)) return { ok: false, reason: `unknown action_name: ${r.action_name}` };
    action_name = r.action_name;
  }
  let alert_json: string | null = null;
  if (r.alert_json !== null && r.alert_json !== undefined) {
    if (typeof r.alert_json !== 'string') return { ok: false, reason: 'alert_json must be a JSON string' };
    if (Buffer.byteLength(r.alert_json, 'utf8') > ALERT_JSON_MAX_BYTES) return { ok: false, reason: 'alert_json exceeds 4 KB' };
    try {
      const parsed = JSON.parse(r.alert_json);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'alert_json must be a JSON object' };
      if (typeof (parsed as any).title !== 'string') return { ok: false, reason: 'alert_json.title must be string' };
      const sev = (parsed as any).severity;
      if (sev !== 'critical' && sev !== 'important' && sev !== 'info') return { ok: false, reason: 'alert_json.severity invalid' };
      const fix = (parsed as any).fix_actions;
      if (!Array.isArray(fix)) return { ok: false, reason: 'alert_json.fix_actions must be array' };
      for (const f of fix) {
        if (typeof f !== 'string' || !KNOWN_ACTION_NAMES.has(f)) return { ok: false, reason: `alert_json.fix_actions has unknown action: ${f}` };
      }
    } catch (e: any) {
      return { ok: false, reason: `alert_json parse error: ${e?.message}` };
    }
    alert_json = r.alert_json;
  }
  return {
    ok: true,
    rule: {
      id: r.id,
      tier: tierNum as 1 | 2 | 3,
      description: r.description,
      trigger: r.trigger,
      cadence,
      action_name,
      alert_json,
      enabled: r.enabled !== false,
    },
  };
}

// v2.4.51 (B49-NAS-2): drain JSON queue files left by
// Refresh-NasRecycleSizes.ps1 into the nas_recycle_sizes cache table.
// Called from api:getNasDrives so the cache stays warm without requiring
// the in-app bridge to be reachable from the scheduled task. Bounded
// per-call so a stuck queue dir can't block the IPC handler.
const NAS_RECYCLE_QUEUE_DIR = 'C:\\ProgramData\\PCDoctor\\queue';
const NAS_RECYCLE_QUEUE_MAX_FILES = 50;

interface QueueRow {
  letter: unknown;
  recycle_bytes: unknown;
  scan_duration_ms?: unknown;
}

async function drainNasRecycleQueue(): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(NAS_RECYCLE_QUEUE_DIR);
  } catch {
    return; // queue dir doesn't exist; nothing to drain
  }
  const queueFiles = entries
    .filter(n => n.startsWith('nas-recycle-') && n.endsWith('.json'))
    .sort()
    .slice(0, NAS_RECYCLE_QUEUE_MAX_FILES);
  for (const name of queueFiles) {
    const filePath = path.join(NAS_RECYCLE_QUEUE_DIR, name);
    try {
      const txt = await readFile(filePath, 'utf8');
      const payload = JSON.parse(txt) as { rows?: QueueRow[] };
      if (Array.isArray(payload?.rows)) {
        for (const row of payload.rows) {
          const letter = typeof row?.letter === 'string' ? row.letter : null;
          const bytes = typeof row?.recycle_bytes === 'number' && Number.isFinite(row.recycle_bytes)
            ? Number(row.recycle_bytes) : null;
          if (letter && bytes !== null) {
            const dur = typeof row?.scan_duration_ms === 'number' && Number.isFinite(row.scan_duration_ms)
              ? Number(row.scan_duration_ms) : null;
            try { upsertNasRecycleSize(letter, bytes, dur); } catch {}
          }
        }
      }
    } catch {
      // malformed queue file — skip and unlink so it doesn't accumulate
    }
    try { await unlink(filePath); } catch {}
  }
}

export function registerIpcHandlers() {
  ipcMain.handle('api:getAppVersion', (): IpcResult<string> => {
    try {
      return { ok: true, data: app.getVersion() };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to read version' } };
    }
  });

  // Browser-style zoom. Matches Ctrl+=, Ctrl+-, Ctrl+0 accelerators wired
  // in main.ts; also callable from the HeaderBar zoom widget. Level is
  // clamped to [-3, 5] which maps roughly to 50% - 250%.
  ipcMain.handle('api:setZoom', (evt, delta: number): IpcResult<number> => {
    try {
      const wc = evt.sender;
      const clamp = (n: number) => Math.max(-3, Math.min(5, n));
      const next = delta === 0 ? 0 : clamp(wc.getZoomLevel() + delta);
      wc.setZoomLevel(next);
      try { setSetting('ui_zoom_level', String(next)); } catch {}
      return { ok: true, data: next };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:getZoom', (evt): IpcResult<number> => {
    try { return { ok: true, data: evt.sender.getZoomLevel() }; }
    catch (e: any) { return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } }; }
  });

  // Main-process clipboard write. navigator.clipboard.writeText() can be
  // blocked in sandboxed renderers (observed in v2.3.13 Reveal Token flow:
  // IPC returned the token but the renderer clipboard API threw). Using
  // Electron's clipboard module from the main process sidesteps the
  // renderer sandbox restriction entirely.
  // v2.4.2: save any action result to the exports folder as a .md file.
  // Sanitizes action_name + timestamp so the filename is deterministic and
  // safe. Path goes into a toast so the user can find the file.
  ipcMain.handle('api:saveActionResult', async (_evt, actionName: string, ts: number, body: string): Promise<IpcResult<{ path: string }>> => {
    try {
      const safeName = String(actionName ?? 'result').replace(/[^a-z0-9_-]/gi, '_').slice(0, 64);
      const stamp = new Date(ts ?? Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const exportsDir = path.join(PCDOCTOR_ROOT, 'exports');
      await mkdir(exportsDir, { recursive: true });
      const filePath = path.join(exportsDir, `${safeName}_${stamp}.md`);
      const { writeFile } = await import('node:fs/promises');
      await writeFile(filePath, typeof body === 'string' ? body : String(body), 'utf8');
      return { ok: true, data: { path: filePath } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:writeClipboard', async (_evt, text: string): Promise<IpcResult<{}>> => {
    try {
      const { clipboard } = await import('electron');
      clipboard.writeText(typeof text === 'string' ? text : '');
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  // v2.4.0: tool update checking. Reads the cache written by Check-ToolUpdates.ps1
  // (weekly scheduled task). Returns { last_checked, upgrades: [...] }.
  ipcMain.handle('api:getToolUpdates', async (): Promise<IpcResult<any>> => {
    try {
      const cachePath = path.join(PCDOCTOR_ROOT, 'tools', 'updates.json');
      if (!existsSync(cachePath)) {
        return { ok: true, data: { winget_available: null, count: 0, upgrades: [], checked_at: null } };
      }
      const raw = await readFile(cachePath, 'utf8');
      return { ok: true, data: JSON.parse(raw) };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  // Trigger a fresh check now (ignores the weekly cache).
  ipcMain.handle('api:refreshToolUpdates', async (): Promise<IpcResult<any>> => {
    try {
      const data = await runPowerShellScript<any>('Check-ToolUpdates.ps1', ['-JsonOutput'], { timeoutMs: 2 * 60 * 1000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  // Upgrade a single tool via winget (runs elevated).
  ipcMain.handle('api:upgradeTool', async (_evt, wingetId: string): Promise<IpcResult<any>> => {
    // Restrict winget_id to a safe charset - the value gets interpolated into
    // a PS -Command string for the elevated upgrade. winget IDs are alnum +
    // dot + hyphen + underscore in practice.
    if (typeof wingetId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(wingetId)) {
      return { ok: false, error: { code: 'E_INVALID_PARAM', message: 'Invalid winget id' } };
    }
    try {
      const { runElevatedPowerShellScript } = await import('./scriptRunner.js');
      const data = await runElevatedPowerShellScript<any>('Upgrade-Tool.ps1', ['-WingetId', wingetId], { timeoutMs: 30 * 60 * 1000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message } };
    }
  });

  // Upgrade all tools with pending updates via winget (runs elevated).
  ipcMain.handle('api:upgradeAllTools', async (): Promise<IpcResult<any>> => {
    try {
      const { runElevatedPowerShellScript } = await import('./scriptRunner.js');
      const data = await runElevatedPowerShellScript<any>('Upgrade-Tool.ps1', ['-All'], { timeoutMs: 2 * 60 * 60 * 1000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message } };
    }
  });

  // Map of action_name -> most-recent successful-run ts (ms). Used by the
  // recommendations engine so "Last emptied Xd ago" reflects reality instead
  // of always showing "Never".
  ipcMain.handle('api:getLastActionSuccessMap', async (): Promise<IpcResult<Record<string, number>>> => {
    try {
      const { getLastActionSuccessMap } = await import('./dataStore.js');
      return { ok: true, data: getLastActionSuccessMap() };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:getStatus', async (): Promise<IpcResult<SystemStatus>> => {
    try {
      const data = await getStatus();
      return { ok: true, data };
    } catch (e) {
      const err = e as PCDoctorBridgeError;
      return { ok: false, error: { code: err.code ?? 'E_INTERNAL', message: err.message ?? 'Failed to read status' } };
    }
  });

  ipcMain.handle('api:runAction', async (_evt, req: RunActionRequest): Promise<IpcResult<ActionResult>> => {
    try {
      const result = await runAction({ name: req.name, params: req.params, dry_run: req.dry_run });
      return { ok: true, data: result };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Action failed' } };
    }
  });

  ipcMain.handle('api:getAuditLog', async (_evt, limit = 200): Promise<IpcResult<AuditLogEntry[]>> => {
    try {
      const rows = listActionLog(limit);
      const entries: AuditLogEntry[] = rows.map((r) => ({
        id: r.id, ts: r.ts, action_name: r.action_name, action_label: r.action_label,
        status: r.status as AuditLogEntry['status'],
        duration_ms: r.duration_ms, error_message: r.error_message,
        rollback_id: r.rollback_id, reverted_at: r.reverted_at,
        triggered_by: r.triggered_by,
        params: r.params_json ? JSON.parse(r.params_json) : null,
        result: r.result_json ? JSON.parse(r.result_json) : null,
      }));
      return { ok: true, data: entries };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to list audit log' } };
    }
  });

  ipcMain.handle('api:revertAction', async (_evt, auditId: number): Promise<IpcResult<RevertResult>> => {
    try {
      const log = getActionLogById(auditId);
      if (!log) return { ok: false, error: { code: 'E_NOT_FOUND', message: 'Action not found' } };
      if (!log.rollback_id) return { ok: false, error: { code: 'E_NOT_FOUND', message: 'This action has no rollback record' } };

      const outcome = await revertRollback(log.rollback_id);
      if (outcome.method !== 'none') markActionReverted(auditId);

      return {
        ok: true,
        data: {
          method: outcome.method,
          reboot_required: outcome.reboot_required,
          details: outcome.method === 'system-restore'
            ? `Windows restore point #${(outcome as any).rp_seq} available via rstrui.exe. Reboot required.`
            : outcome.method === 'file-snapshot'
              ? `${(outcome as any).files_restored} file(s) restored from snapshot.`
              : (outcome as any).reason ?? 'Cannot revert',
        },
      };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Revert failed' } };
    }
  });

  ipcMain.handle('api:getTrend', async (_evt, req: { category: string; metric: string; days: number }): Promise<IpcResult<Trend>> => {
    try {
      const points = queryMetricTrend(req.category, req.metric, req.days ?? 7);
      return {
        ok: true,
        data: {
          metric: `${req.category}.${req.metric}`,
          unit: req.metric.includes('pct') ? '%' : '',
          points: points.map(p => ({ ts: Math.floor(p.ts / 1000), value: p.value })),
        },
      };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to query trend' } };
    }
  });

  ipcMain.handle('api:getForecast', async (): Promise<IpcResult<ForecastData>> => {
    try {
      // Return cached if recent; otherwise regenerate
      const cached = loadForecasts();
      if (cached && (Date.now() / 1000 - cached.generated_at) < 12 * 3600) {
        return { ok: true, data: cached as ForecastData };
      }
      const fresh = generateForecasts();
      return { ok: true, data: fresh };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Forecast failed' } };
    }
  });

  ipcMain.handle('api:regenerateForecast', async (): Promise<IpcResult<ForecastData>> => {
    try {
      const fresh = generateForecasts();
      return { ok: true, data: fresh };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Forecast failed' } };
    }
  });

  ipcMain.handle('api:getWeeklyReview', async (_evt, reviewDate?: string): Promise<IpcResult<WeeklyReview | null>> => {
    try {
      // v2.4.49 (B48-AUDIT-2): refuse any renderer-supplied reviewDate that
      // doesn't match YYYY-MM-DD. Even though the existing files.find
      // existsSync path is filesystem-bounded, defence-in-depth: validate
      // at the handler boundary, not the sink.
      if (reviewDate !== undefined && !REVIEW_DATE_RE.test(reviewDate)) {
        return { ok: false, error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' } };
      }
      if (!existsSync(weeklyDir)) return { ok: true, data: null };
      const files = (await readdir(weeklyDir)).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) return { ok: true, data: null };
      const pickFile = reviewDate ? files.find(f => f.startsWith(reviewDate)) : files[0];
      if (!pickFile) return { ok: true, data: null };
      const filePath = path.join(weeklyDir, pickFile);
      let raw = await readFile(filePath, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw) as WeeklyReview;
      data.has_pending_flag = existsSync(path.join(weeklyDir, '.pending-review'));
      // Merge persisted states
      const states = getReviewItemStates(data.review_date);
      for (const item of data.action_items) {
        const s = states[item.id];
        if (s) {
          item.state = s.state as any;
        }
      }
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to load weekly review' } };
    }
  });

  ipcMain.handle('api:listWeeklyReviews', async (): Promise<IpcResult<string[]>> => {
    try {
      if (!existsSync(weeklyDir)) return { ok: true, data: [] };
      const files = (await readdir(weeklyDir))
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''))
        .sort().reverse();
      return { ok: true, data: files };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:setWeeklyReviewItemState', async (_evt, reviewDate: string, itemId: string, state: string, appliedActionId?: number): Promise<IpcResult<{}>> => {
    // v2.4.49 (B48-AUDIT-3): third reviewDate callsite. better-sqlite3 binds
    // parameters so SQL injection is not the threat, but the unvalidated
    // string lands in `weekly_review_states` as a TEXT primary key. Future
    // code that reads this back and feeds it to `path.join` would re-open
    // the traversal that B48-AUDIT-1/2 closed. Same allowlist for parity.
    if (!REVIEW_DATE_RE.test(reviewDate)) {
      return { ok: false, error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' } };
    }
    try {
      setReviewItemState(reviewDate, itemId, state as any, appliedActionId);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:archiveWeeklyReviewToObsidian', async (_evt, reviewDate: string): Promise<IpcResult<{ archive_path: string }>> => {
    try {
      // v2.4.49 (B48-AUDIT-1): reject path-traversal payloads at the handler
      // boundary. Without this, '../../etc/passwd' would let `${reviewDate}.md`
      // resolve OUTSIDE weeklyDir and a maliciously named source file would
      // satisfy the existsSync check, causing a copyFile to an attacker-
      // chosen destination.
      if (!REVIEW_DATE_RE.test(reviewDate)) {
        return { ok: false, error: { code: 'E_INVALID_DATE', message: 'reviewDate must match YYYY-MM-DD' } };
      }
      const sourceMd = path.join(weeklyDir, `${reviewDate}.md`);
      if (!existsSync(sourceMd)) return { ok: false, error: { code: 'E_NOT_FOUND', message: 'Review markdown not found' } };
      // Reviewer P2: path was hardcoded to greg_'s dev box. Read from a
      // setting so fresh installs on other machines don't try to write
      // into a non-existent directory.
      const configured = getSetting('obsidian_archive_dir') ?? '';
      const obsidianDir = configured.trim()
        ? configured
        : path.join(app.getPath('documents'), 'PCDoctor', 'Weekly Reviews');
      await mkdir(obsidianDir, { recursive: true });
      const destPath = path.join(obsidianDir, `${reviewDate}.md`);
      await copyFile(sourceMd, destPath);
      return { ok: true, data: { archive_path: destPath } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:dismissWeeklyReviewFlag', async (): Promise<IpcResult<void>> => {
    try {
      const flagPath = path.join(weeklyDir, '.pending-review');
      if (existsSync(flagPath)) await unlink(flagPath);
      return { ok: true, data: undefined };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to dismiss flag' } };
    }
  });

  ipcMain.handle('api:getSecurityPosture', async (): Promise<IpcResult<SecurityPosture>> => {
    try {
      // Run all four PS scans in parallel; combined worst-case latency drops
      // from ~300s sequential to ~120s (bounded by the slowest probe).
      // v2.4.51 (B51-IPC-1): switch from Promise.all + per-call .catch to
      // Promise.allSettled so we can surface per-scan failure to the
      // renderer via `partial_errors` instead of silently substituting
      // empty arrays. The primary Get-SecurityPosture.ps1 stays
      // hard-required (no posture data → return ok:false).
      const settled = await Promise.allSettled([
        runPowerShellScript<any>('security/Get-SecurityPosture.ps1', ['-JsonOutput'], { timeoutMs: 120_000 }),
        runPowerShellScript<any>('security/Audit-Persistence.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }),
        runPowerShellScript<any>('security/Get-ThreatIndicators.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }),
        runPowerShellScript<any>('security/Get-SMART.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }),
      ]);

      const partial_errors: Array<{ name: string; code: string; message: string }> = [];
      const settledPosture = settled[0];
      const settledAudit = settled[1];
      const settledThreats = settled[2];
      const settledSmart = settled[3];

      if (settledPosture.status === 'rejected') {
        // Hard failure — no posture data to return.
        const err: any = settledPosture.reason;
        return { ok: false, error: { code: err?.code ?? 'E_INTERNAL', message: err?.message ?? 'Security scan failed' } };
      }
      const posture = settledPosture.value;
      let audit: any;
      if (settledAudit.status === 'fulfilled') {
        audit = settledAudit.value;
      } else {
        const err: any = settledAudit.reason;
        partial_errors.push({ name: 'audit-persistence', code: err?.code ?? 'E_INTERNAL', message: err?.message ?? 'Audit-Persistence failed' });
        audit = { items: [] };
      }
      let threats: any;
      if (settledThreats.status === 'fulfilled') {
        threats = settledThreats.value;
      } else {
        const err: any = settledThreats.reason;
        partial_errors.push({ name: 'threat-indicators', code: err?.code ?? 'E_INTERNAL', message: err?.message ?? 'Get-ThreatIndicators failed' });
        threats = { indicators: [] };
      }
      let smart: any;
      if (settledSmart.status === 'fulfilled') {
        smart = settledSmart.value;
      } else {
        const err: any = settledSmart.reason;
        partial_errors.push({ name: 'smart', code: err?.code ?? 'E_INTERNAL', message: err?.message ?? 'Get-SMART failed' });
        smart = { drives: [] };
      }

      // Upsert persistence items into baseline and compute is_new flag
      const persistenceItems: PersistenceItem[] = [];
      for (const raw of (audit.items ?? [])) {
        const { is_new, row } = upsertPersistence({
          kind: raw.kind, identifier: raw.identifier, name: raw.name,
          path: raw.path, publisher: raw.publisher,
        });
        persistenceItems.push({
          kind: raw.kind as PersistenceItem['kind'], identifier: row.identifier,
          name: row.name, path: row.path ?? undefined, publisher: row.publisher ?? undefined,
          signed: row.signed === null ? undefined : !!row.signed,
          first_seen: row.first_seen, last_seen: row.last_seen,
          approved: row.approved as -1 | 0 | 1, is_new,
        });
      }

      const data: SecurityPosture = {
        generated_at: posture.generated_at,
        defender: posture.defender,
        firewall: posture.firewall,
        windows_update: posture.windows_update,
        failed_logins: posture.failed_logins,
        bitlocker: posture.bitlocker ?? [],
        uac: posture.uac,
        gpu_driver: posture.gpu_driver,
        persistence_new_count: countNewPersistence(24),
        persistence_items: persistenceItems.filter(i => i.is_new || i.approved !== 1).slice(0, 100),
        threat_indicators: (threats.indicators ?? []) as ThreatIndicator[],
        smart: (smart.drives ?? []).map((d: any) => ({
          drive: d.drive,
          model: d.model,
          health: d.health,
          wear_pct: d.wear_pct,
          temp_c: d.temp_c,
          media_errors: d.media_errors,
          power_on_hours: d.power_on_hours,
          status_severity: d.status_severity ?? 'good',
          // v2.4.18: preserve the admin-required flag through to the
          // renderer. Previously dropped here, which meant SmartTable's
          // "Run SMART Check (admin)" button never appeared, the `admin`
          // placeholder was replaced with `-`, and the user had no way to
          // discover that wear/temp required elevation.
          needs_admin: d.needs_admin === true,
        })),
        overall_severity: posture.overall_severity ?? 'good',
        partial_errors,  // v2.4.51 (B51-IPC-1)
      };
      setCachedSmart(data.smart);

      // Auto-block RDP brute-force source IPs if setting enabled.
      // Reviewer P1: previously this called runPowerShellScript directly,
      // bypassing actionRunner's audit log / rollback / admin routing /
      // notifier pipeline. Route through runAction() so auto-blocks show up
      // in History like any user-initiated action.
      const autoBlockEnabled = getSetting('auto_block_rdp_bruteforce') === '1';
      if (autoBlockEnabled) {
        for (const ti of data.threat_indicators) {
          if (ti.category === 'rdp_bruteforce' && (ti.detail as any)?.auto_block_candidates) {
            const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
            for (const ip of ((ti.detail as any).auto_block_candidates as string[])) {
              if (typeof ip !== 'string' || !ipv4Re.test(ip)) continue;
              try {
                await runAction({
                  name: 'block_ip',
                  params: { ip, reason: 'Auto-block: RDP brute-force' },
                  triggered_by: 'alert',
                });
              } catch {}
            }
          }
        }
      }

      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Security scan failed' } };
    }
  });

  ipcMain.handle('api:listBlockedIPs', async (): Promise<IpcResult<any[]>> => {
    try {
      const r = await runPowerShellScript<any>('security/List-BlockedIPs.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
      return { ok: true, data: r.rules ?? [] };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:listToolResults', async (_evt, toolId?: string): Promise<IpcResult<any[]>> => {
    try {
      const rows = listToolResults(toolId, 20);
      return { ok: true, data: rows.map(r => ({
        id: r.id, ts: r.ts, tool_id: r.tool_id, csv_path: r.csv_path, samples: r.samples,
        summary: r.summary, findings: r.findings_json ? JSON.parse(r.findings_json) : null,
      })) };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:approvePersistence', async (_evt, identifier: string, approve: boolean): Promise<IpcResult<void>> => {
    try {
      setPersistenceApproval(identifier, approve ? 1 : -1);
      return { ok: true, data: undefined };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to update approval' } };
    }
  });

  ipcMain.handle('api:listTools', async (): Promise<IpcResult<ToolStatus[]>> => {
    try { return { ok: true, data: listAllToolStatuses() }; }
    catch (e: any) { return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } }; }
  });

  ipcMain.handle('api:launchTool', async (_evt, toolId: string, modeId: string): Promise<IpcResult<{ pid?: number }>> => {
    const r = await launchTool(toolId, modeId);
    if (r.ok) return { ok: true, data: { pid: r.pid } };
    return { ok: false, error: { code: 'E_TOOL_LAUNCH', message: r.error ?? 'Launch failed' } };
  });

  ipcMain.handle('api:installTool', async (_evt, toolId: string): Promise<IpcResult<{}>> => {
    const def = TOOLS[toolId];
    if (!def) {
      return { ok: false, error: { code: 'E_TOOL_UNKNOWN', message: `Unknown tool: ${toolId}` } };
    }
    // Dispatch:
    //   winget_id present    → winget install
    //   download_url present → direct HTTPS download to detect_paths[0]
    //   neither              → error (e.g. MSIX-only tools, native-only tools)
    if (def.winget_id) {
      const r = await installToolViaWinget(toolId);
      return r.ok
        ? { ok: true, data: {} }
        : { ok: false, error: { code: 'E_TOOL_INSTALL', message: r.error ?? 'Install failed' } };
    }
    if (def.download_url) {
      const r = await installToolViaDirectDownload(toolId);
      return r.ok
        ? { ok: true, data: {} }
        : { ok: false, error: { code: 'E_TOOL_DOWNLOAD', message: r.error ?? 'Download failed' } };
    }
    return {
      ok: false,
      error: {
        code: 'E_TOOL_INSTALL_UNAVAILABLE',
        message: `No install method configured for '${def.name}' (no winget_id or download_url).`,
      },
    };
  });

  ipcMain.handle('api:getDefenderScanStatus', async (): Promise<IpcResult<any>> => {
    try {
      const data = await runPowerShellScript<any>('security/Get-DefenderScanStatus.ps1', ['-JsonOutput'], { timeoutMs: 15_000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to read Defender scan status' } };
    }
  });

  ipcMain.handle('api:getWindowsUpdateDetail', async (): Promise<IpcResult<any>> => {
    try {
      const data = await runPowerShellScript<any>('security/Get-WindowsUpdateDetail.ps1', ['-JsonOutput'], { timeoutMs: 120_000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to fetch WU detail' } };
    }
  });

  ipcMain.handle('api:getFeatureUpgradeReadiness', async (): Promise<IpcResult<any>> => {
    try {
      const data = await runPowerShellScript<any>('security/Get-FeatureUpgradeReadiness.ps1', ['-JsonOutput'], { timeoutMs: 60_000 });
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:getNvidiaDriverLatest', async (): Promise<IpcResult<any>> => {
    try {
      const data = await runPowerShellScript<any>('security/Check-NvidiaDriverLatest.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
      // v2.5.9 (B4): cache the check result so Updates page can show
      // "Last checked Xd ago" without re-running PowerShell on every mount.
      // The Check-NvidiaDriverLatest.ps1 hits the Nvidia driver feed
      // (HTTPS, ~3-5s); cache lets us reflect prior state instantly.
      try {
        const { setSetting } = await import('./dataStore.js');
        setSetting('nvidia_check_cache', JSON.stringify({
          ts: Date.now(),
          installed_version: data?.installed_version ?? null,
          latest_version: data?.latest_version ?? null,
          message: data?.message ?? null,
        }));
      } catch (cacheErr: any) {
        // Non-fatal — return the live result regardless of cache write.
        console.warn(`ipc: nvidia_check_cache write failed: ${cacheErr?.message ?? cacheErr}`);
      }
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:getClaudeStatus', async (): Promise<IpcResult<{ installed: boolean; path: string | null }>> => {
    const p = resolveClaudePath();
    return { ok: true, data: { installed: !!p, path: p } };
  });

  ipcMain.handle('api:launchClaude', async (): Promise<IpcResult<{ pid?: number }>> => {
    const r = await launchClaudeInTerminal();
    if (r.ok) return { ok: true, data: { pid: r.pid } };
    return { ok: false, error: { code: 'E_CLAUDE_LAUNCH', message: r.error ?? 'Launch failed' } };
  });

  ipcMain.handle('api:investigateWithClaude', async (_evt, contextText: string): Promise<IpcResult<{ pid?: number }>> => {
    const r = await launchClaudeWithContext(contextText);
    if (r.ok) return { ok: true, data: { pid: r.pid } };
    return { ok: false, error: { code: 'E_CLAUDE_LAUNCH', message: r.error ?? 'Launch failed' } };
  });

  ipcMain.handle('api:getSettings', async (): Promise<IpcResult<Record<string, string>>> => {
    try {
      const all = getAllSettings();

      // Allow-list of keys that the renderer is permitted to read. Anything not matching
      // is filtered out so that a new sensitive setting added later doesn't leak by default.
      const RENDERER_SAFE_KEYS = new Set<string>([
        'telegram_bot_token', 'telegram_chat_id', 'telegram_enabled',
        'quiet_hours_start', 'quiet_hours_end',
        'email_digest_recipient', 'digest_hour',
        'auto_block_rdp_bruteforce',
        'telegram_last_good_ts', 'selftest_banner',
        'obsidian_archive_dir',
        // v2.5.9 (B4): Nvidia driver check cache (driver versions + epoch ms,
        // no sensitive data). Written main-side by api:getNvidiaDriverLatest;
        // read renderer-side on Updates.tsx mount to hydrate staleness UI.
        'nvidia_check_cache',
      ]);
      const isSafeKey = (k: string) => RENDERER_SAFE_KEYS.has(k) || k.startsWith('event:');

      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(all)) {
        if (isSafeKey(k)) filtered[k] = v;
      }

      // Mask sensitive values - never return plaintext tokens to the renderer.
      for (const k of ['telegram_bot_token']) {
        const v = filtered[k];
        if (v) {
          if (v.startsWith('dpapi:')) {
            filtered[k] = '***encrypted***';
          } else {
            // Legacy unencrypted - mask preserving first/last few chars
            filtered[k] = v.length > 10 ? `${v.slice(0, 4)}...${v.slice(-4)}` : '***';
          }
        }
      }
      return { ok: true, data: filtered };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:revealTelegramToken', async (): Promise<IpcResult<{ token: string }>> => {
    try {
      const raw = getSetting('telegram_bot_token') ?? '';
      let token = raw;
      if (raw.startsWith('dpapi:') && safeStorage.isEncryptionAvailable()) {
        try {
          const ct = Buffer.from(raw.slice(6), 'base64');
          token = safeStorage.decryptString(ct);
        } catch {
          token = '';
        }
      }
      return { ok: true, data: { token } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:setSetting', async (_evt, key: string, value: string): Promise<IpcResult<{}>> => {
    // Allowlist: only permit keys the renderer is allowed to modify.
    const WRITABLE_KEYS = new Set<string>([
      'telegram_bot_token', 'telegram_chat_id', 'telegram_enabled',
      'quiet_hours_start', 'quiet_hours_end',
      'email_digest_recipient', 'digest_hour',
      'auto_block_rdp_bruteforce',
      'obsidian_archive_dir',
    ]);
    const isWritable = (k: string) => WRITABLE_KEYS.has(k) || k.startsWith('event:');
    if (!isWritable(key)) {
      return { ok: false, error: { code: 'E_FORBIDDEN', message: `Setting '${key}' cannot be modified from the renderer` } };
    }
    try {
      if (key === 'telegram_bot_token' && value && safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(value).toString('base64');
        setSetting(key, `dpapi:${encrypted}`);
      } else {
        setSetting(key, value);
      }
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:testTelegram', async (_evt, token: string, chatId: string): Promise<IpcResult<{ bot_username?: string }>> => {
    const r = await testTelegramConnection(token, chatId);
    if (r.ok) return { ok: true, data: { bot_username: r.bot_username } };
    return { ok: false, error: { code: 'E_TG_TEST', message: r.error ?? 'test failed' } };
  });

  ipcMain.handle('api:sendTestNotification', async (): Promise<IpcResult<{}>> => {
    const r = await sendTelegramMessage('🧪 <b>Test notification from PCDoctor Workbench</b>\n\nThis is a manual test - ignore.');
    if (r.ok) return { ok: true, data: {} };
    return { ok: false, error: { code: 'E_TG_SEND', message: r.error ?? 'send failed' } };
  });

  ipcMain.handle('api:sendTelegramTestFull', async (): Promise<IpcResult<{ sent_at: number }>> => {
    // Full round-trip test with inline keyboard. Callback responses are handled in main.ts:
    //   tgtest_ok  → records settings.telegram_last_good_ts
    //   tgtest_fail → writes audit log entry with telegram_callback_failed = true
    const { makeCallbackData } = await import('./telegramBridge.js');
    const r = await sendTelegramMessage(
      '🧪 <b>PCDoctor Telegram test</b>\n\n' +
      'If you see this message and the buttons below work, the channel is healthy.',
      [[
        { text: '✓ Received', callback_data: makeCallbackData('tgtest_ok') },
        { text: '❌ Buttons don\'t work', callback_data: makeCallbackData('tgtest_fail') },
      ]],
    );
    if (r.ok) return { ok: true, data: { sent_at: Date.now() } };
    return { ok: false, error: { code: 'E_TG_SEND', message: r.error ?? 'send failed' } };
  });

  // v2.3.0 B3 fix #3: include the 11 Autopilot tasks so the Settings page's
  // scheduled-tasks table shows them and Run-Now works on each.
  const MANAGED_TASKS = new Set([
    'PCDoctor-Workbench-Autostart', 'PCDoctor-Daily-Quick', 'PCDoctor-Weekly',
    'PCDoctor-Weekly-Review', 'PCDoctor-Forecast', 'PCDoctor-Security-Daily',
    'PCDoctor-Security-Weekly', 'PCDoctor-Prune-Rollbacks', 'PCDoctor-Monthly-Deep',
    'PCDoctor-Autopilot-SmartCheck',
    'PCDoctor-Autopilot-DefenderQuickScan',
    'PCDoctor-Autopilot-UpdateDefenderDefs',
    'PCDoctor-Autopilot-EmptyRecycleBins',
    'PCDoctor-Autopilot-ClearBrowserCaches',
    'PCDoctor-Autopilot-MalwarebytesCli',
    'PCDoctor-Autopilot-AdwCleanerScan',
    'PCDoctor-Autopilot-SafetyScanner',
    'PCDoctor-Autopilot-HwinfoLog',
    'PCDoctor-Autopilot-UpdateHostsStevenBlack',
    'PCDoctor-Autopilot-ShrinkComponentStore',
    // v2.4.51 (B49-NAS-2): Settings page Run-Now / Enable / Disable on the
    // new daily NAS @Recycle refresh task.
    'PCDoctor-Autopilot-RefreshNasRecycleSizes',
  ]);

  ipcMain.handle('api:listScheduledTasks', async (): Promise<IpcResult<ScheduledTaskInfo[]>> => {
    // Delegate to Get-ScheduledTasksStatus.ps1 (COM-based enumeration via
    // Schedule.Service). The hang note here applies ONLY to schtasks /Query
    // WITHOUT /TN — that's why this enumerator goes via COM. The two
    // schtasks /Change /TN and /Run /TN handlers below were hardened in
    // v2.4.48 (B48-SEC-1) to call schtasks.exe directly via execFile +
    // an allowlist regex, since the /TN-bearing path doesn't trip the hang.
    // See runSchtasks at the top of this file.
    try {
      const r = await runPowerShellScript<{ success: boolean; tasks: ScheduledTaskInfo[] }>(
        'Get-ScheduledTasksStatus.ps1', ['-JsonOutput'], { timeoutMs: 30_000 }
      );
      const data = (r.tasks ?? []).map(t => ({
        name: t.name,
        status: t.status || 'Unknown',
        next_run: (t.next_run && t.next_run !== 'N/A') ? t.next_run : null,
        last_run: (t.last_run && !t.last_run.startsWith('11/30/1999')) ? t.last_run : null,
        last_result: t.last_result ?? null,
      }));
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Failed to query tasks' } };
    }
  });

  ipcMain.handle('api:setScheduledTaskEnabled', async (_evt, name: string, enabled: boolean): Promise<IpcResult<{}>> => {
    // v2.4.48 (B48-SEC-1): regex allowlist BEFORE the MANAGED_TASKS.has
    // check. The regex catches shell-metachar smuggling regardless of
    // whether MANAGED_TASKS is later weakened. A name like
    // `PCDoctor-Foo; rm -rf /` would have failed MANAGED_TASKS.has
    // anyway, but two-layer defence costs nothing.
    if (typeof name !== 'string' || !SCHEDULED_TASK_NAME_RE.test(name)) {
      return { ok: false, error: { code: 'E_FORBIDDEN', message: `Task '${name}' has an invalid name` } };
    }
    if (!MANAGED_TASKS.has(name)) {
      return { ok: false, error: { code: 'E_FORBIDDEN', message: `Task '${name}' is not managed by PCDoctor` } };
    }
    try {
      await runSchtasks(['/Change', '/TN', name, enabled ? '/ENABLE' : '/DISABLE']);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_SCHTASKS', message: e?.stderr || e?.message || 'schtasks failed' } };
    }
  });

  ipcMain.handle('api:runScheduledTaskNow', async (_evt, name: string): Promise<IpcResult<{}>> => {
    // v2.4.48 (B48-SEC-1): see api:setScheduledTaskEnabled comment.
    if (typeof name !== 'string' || !SCHEDULED_TASK_NAME_RE.test(name)) {
      return { ok: false, error: { code: 'E_FORBIDDEN', message: `Task '${name}' has an invalid name` } };
    }
    if (!MANAGED_TASKS.has(name)) {
      return { ok: false, error: { code: 'E_FORBIDDEN', message: `Task '${name}' is not managed by PCDoctor` } };
    }
    try {
      await runSchtasks(['/Run', '/TN', name]);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_SCHTASKS', message: e?.stderr || e?.message || 'schtasks failed' } };
    }
  });

  ipcMain.handle('api:listAutopilotRules', async (): Promise<IpcResult<any[]>> => {
    try {
      const rows = listAutopilotRules().map(r => ({
        id: r.id,
        tier: r.tier,
        description: r.description,
        trigger: r.trigger,
        cadence: r.cadence,
        action_name: r.action_name,
        alert: r.alert_json ? JSON.parse(r.alert_json) : null,
        enabled: r.enabled === 1,
        suppressed_until: r.suppressed_until,
      }));
      return { ok: true, data: rows };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:getAutopilotActivity', async (_evt, daysBack = 30): Promise<IpcResult<any[]>> => {
    try {
      return { ok: true, data: getAutopilotActivity(daysBack) };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:suppressAutopilotRule', async (_evt, ruleId: string, hours: number): Promise<IpcResult<{}>> => {
    try {
      const safeHours = Math.max(1, Math.min(24 * 30, hours)); // clamp 1h..30d
      suppressAutopilotRule(ruleId, Date.now() + safeHours * 60 * 60 * 1000);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  // v2.3.0 C2: Autopilot rule editor IPC
  ipcMain.handle('api:setAutopilotRuleEnabled', async (_evt, ruleId: string, enabled: boolean): Promise<IpcResult<{}>> => {
    try {
      setAutopilotRuleEnabled(ruleId, enabled);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:runAutopilotRuleNow', async (_evt, ruleId: string): Promise<IpcResult<{ outcome: string; message?: string }>> => {
    try {
      const rule = getAutopilotRule(ruleId);
      if (!rule) return { ok: false, error: { code: 'E_NOT_FOUND', message: `Rule '${ruleId}' not found` } };
      if (rule.trigger === 'threshold') {
        const status = await getStatus();
        const history = {
          isSustainedAbove(category: string, metric: string, threshold: number, days: number): boolean {
            try {
              const { queryMetricTrend } = require('./dataStore.js');
              const points = queryMetricTrend(category, metric, days);
              if (!Array.isArray(points) || points.length < 3) return false;
              const above = points.filter((p: any) => p.value > threshold).length;
              return above / points.length >= 0.8;
            } catch { return false; }
          },
        };
        const decision = evaluateRule(rule, status, history);
        if (!decision) {
          insertAutopilotActivity({
            rule_id: ruleId,
            tier: rule.tier as 1 | 2 | 3,
            outcome: 'skipped',
            message: 'run-now: rule conditions not met',
          });
          return { ok: true, data: { outcome: 'skipped', message: 'Rule conditions not currently met.' } };
        }
        // minGapMs=0 so user-triggered runs bypass the 6h rate-limit.
        await dispatchDecision(decision, 0);
        return { ok: true, data: { outcome: 'dispatched', message: decision.reason } };
      }
      // Schedule rules: trigger the underlying action directly
      if (!rule.action_name) {
        return { ok: false, error: { code: 'E_INVALID', message: 'Schedule rule has no action_name' } };
      }
      const t0 = Date.now();
      const r = await runAction({ name: rule.action_name as any, triggered_by: 'user' });
      insertAutopilotActivity({
        rule_id: ruleId,
        tier: rule.tier as 1 | 2 | 3,
        action_name: rule.action_name as any,
        outcome: r.success ? 'auto_run' : 'error',
        duration_ms: Date.now() - t0,
        message: r.success ? 'run-now from UI' : (r.error?.message ?? 'error'),
      });
      return { ok: true, data: { outcome: r.success ? 'auto_run' : 'error', message: r.error?.message } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:exportAutopilotRules', async (): Promise<IpcResult<{ rules: any[] }>> => {
    try {
      const rules = listAutopilotRules().map(r => ({
        id: r.id,
        tier: r.tier,
        description: r.description,
        trigger: r.trigger,
        cadence: r.cadence,
        action_name: r.action_name,
        alert_json: r.alert_json,
        enabled: r.enabled === 1,
      }));
      return { ok: true, data: { rules } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:importAutopilotRules', async (_evt, payload: { rules: any[] }): Promise<IpcResult<{ imported: number; rejected: number; errors: string[] }>> => {
    try {
      const { upsertAutopilotRule } = await import('./dataStore.js');
      let imported = 0;
      let rejected = 0;
      const errors: string[] = [];
      const incoming = Array.isArray(payload?.rules) ? payload.rules : [];
      // v2.4.51 (B51-IPC-3): hard cap on payload size. Prevents a 10k-rule
      // import from blocking the main thread; 200 is ~10x DEFAULT_RULES.
      if (incoming.length > 200) {
        return { ok: false, error: { code: 'E_INVALID_RULE_IMPORT', message: 'too many rules (max 200)' } };
      }
      for (const raw of incoming) {
        const v = validateImportedRule(raw);
        if (!v.ok) {
          rejected++;
          if (errors.length < 20) errors.push(`${(raw as any)?.id ?? '<unnamed>'}: ${v.reason}`);
          continue;
        }
        upsertAutopilotRule(v.rule);
        imported++;
      }
      return { ok: true, data: { imported, rejected, errors } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:exportClaudeReport', async (): Promise<IpcResult<ClaudeReport>> => {
    try {
      const report = buildClaudeReport();
      return { ok: true, data: report };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_EXPORT_FAILED', message: e?.message ?? 'export failed' } };
    }
  });

  ipcMain.handle('api:exportDiagnosticBundle', async (): Promise<IpcResult<{ path: string; size_kb: number }>> => {
    try {
      const outDir = path.join(process.env.APPDATA ?? '', 'PCDoctor');
      if (!existsSync(outDir)) await mkdir(outDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const outPath = path.join(outDir, `pcdoctor-diag-${ts}.zip`);

      const zip = new AdmZip();
      const addIfExists = (p: string, zipPath: string) => {
        if (existsSync(p)) {
          try {
            // AdmZip.addLocalFile(localPath, zipPath, zipName): use parent dir in zipPath
            const parts = zipPath.split('/');
            const filename = parts.pop()!;
            const zipDir = parts.join('/');
            zip.addLocalFile(p, zipDir, filename);
          } catch {}
        }
      };

      // 1. Settings (redact token)
      try {
        const settingsRow = (await import('./dataStore.js')).getAllSettings();
        delete settingsRow.telegram_bot_token;
        zip.addFile('settings.json', Buffer.from(JSON.stringify(settingsRow, null, 2), 'utf8'));
      } catch {}

      // 2. Version info
      const pkgPath = path.join(process.resourcesPath, 'app.asar', 'package.json');
      const fallbackPkg = path.join(process.cwd(), 'package.json');
      let version = 'unknown';
      try {
        const raw = existsSync(pkgPath) ? await readFile(pkgPath, 'utf8') : await readFile(fallbackPkg, 'utf8');
        version = JSON.parse(raw).version ?? 'unknown';
      } catch {}
      zip.addFile('version.txt', Buffer.from(`PCDoctor Workbench ${version}\nNode ${process.versions.node}\nElectron ${process.versions.electron}\nChrome ${process.versions.chrome}\n`, 'utf8'));

      // 3. Latest report
      addIfExists('C:\\ProgramData\\PCDoctor\\reports\\latest.json', 'reports/latest.json');
      addIfExists('C:\\ProgramData\\PCDoctor\\reports\\latest.md', 'reports/latest.md');

      // 4. Recent weekly reviews
      try {
        const weeklyReportsDir = 'C:\\ProgramData\\PCDoctor\\reports\\weekly';
        if (existsSync(weeklyReportsDir)) {
          const files = (await readdir(weeklyReportsDir)).filter(f => f.endsWith('.md')).slice(-4);
          for (const f of files) {
            addIfExists(path.join(weeklyReportsDir, f), `reports/weekly/${f}`);
          }
        }
      } catch {}

      // 5. Recent logs
      try {
        const logDir = path.join(process.env.APPDATA ?? '', 'PCDoctor', 'logs');
        if (existsSync(logDir)) {
          const files = await readdir(logDir);
          for (const f of files.slice(-7)) {
            addIfExists(path.join(logDir, f), `logs/${f}`);
          }
        }
      } catch {}

      // 6. Action history JSON
      try {
        const { listActionLog } = await import('./dataStore.js');
        const logs = listActionLog(500);
        zip.addFile('audit/actions_log.json', Buffer.from(JSON.stringify(logs, null, 2), 'utf8'));
      } catch {}

      zip.writeZip(outPath);
      const s = await stat(outPath);
      return { ok: true, data: { path: outPath, size_kb: Math.round(s.size / 1024) } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:flushBufferedNotifications', async (): Promise<IpcResult<{ sent: number }>> => {
    try {
      const r = await flushBufferedNotifications();
      return { ok: true, data: r };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:sendWeeklyDigestEmail', async (): Promise<IpcResult<{}>> => {
    const r = await sendWeeklyDigestEmail();
    if (r.ok) return { ok: true, data: {} };
    return { ok: false, error: { code: 'E_EMAIL_DIGEST', message: r.error ?? 'send failed' } };
  });

  ipcMain.handle('api:getRecentAuthEvents', async (): Promise<IpcResult<any[]>> => {
    try {
      const r = await runPowerShellScript<any>('security/Get-RecentAuthEvents.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
      return { ok: true, data: r.events ?? [] };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  // v2.4.51 (B51-IPC-2): the four update-check IPC handlers were bare; an
  // electron-updater exception escaped as an unhandled rejection on the
  // renderer side and the UI showed a generic IPC error. Wrap each in
  // try/catch with E_UPDATE_* error codes so the UI can render an actionable
  // message.
  ipcMain.handle('api:getUpdateStatus', async (): Promise<IpcResult<UpdateStatus>> => {
    try {
      return { ok: true, data: getUpdaterStatus() };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_UPDATE_STATUS', message: e?.message ?? 'Failed to read update status' } };
    }
  });

  ipcMain.handle('api:checkForUpdates', async (): Promise<IpcResult<UpdateStatus>> => {
    try {
      await checkForUpdates();
      return { ok: true, data: getUpdaterStatus() };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_UPDATE_CHECK', message: e?.message ?? 'Update check failed' } };
    }
  });

  ipcMain.handle('api:downloadUpdate', async (): Promise<IpcResult<UpdateStatus>> => {
    try {
      await downloadUpdate();
      return { ok: true, data: getUpdaterStatus() };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_UPDATE_DOWNLOAD', message: e?.message ?? 'Update download failed' } };
    }
  });

  ipcMain.handle('api:installUpdateNow', async (): Promise<IpcResult<{}>> => {
    try {
      installNow();
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_UPDATE_INSTALL', message: e?.message ?? 'Update install failed' } };
    }
  });

  // v2.4.6: NAS config settings (server IP + drive mappings). Read is
  // cheap, pulls from DB with defaults. Write validates and syncs the
  // sidecar JSON so the scanner + Remap-NAS action pick up changes
  // immediately without requiring an app restart.
  ipcMain.handle('api:getNasConfig', async (): Promise<IpcResult<{ nas_server: string; nas_mappings: Array<{ drive: string; share: string }> }>> => {
    try {
      const { readNasConfig } = await import('./nasConfig.js');
      const cfg = readNasConfig();
      return { ok: true, data: { nas_server: cfg.nas_server, nas_mappings: cfg.nas_mappings } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to read NAS config' } };
    }
  });

  ipcMain.handle('api:setNasConfig', async (_evt, payload: { nas_server: string; nas_mappings: Array<{ drive: string; share: string }> }): Promise<IpcResult<{}>> => {
    try {
      const { writeNasConfig } = await import('./nasConfig.js');
      writeNasConfig(payload.nas_server, payload.nas_mappings);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_VALIDATION', message: e?.message ?? 'Invalid NAS config' } };
    }
  });

  // v2.4.13: Startup config (threshold + allowlist). Read returns current
  // settings or defaults. Write validates and syncs the sidecar JSON so
  // the next scan picks up changes without app restart.
  ipcMain.handle('api:getStartupConfig', async (): Promise<IpcResult<{ threshold: number; allowlist: string[] }>> => {
    try {
      const { readStartupConfig } = await import('./startupConfig.js');
      const cfg = readStartupConfig();
      return { ok: true, data: { threshold: cfg.threshold, allowlist: cfg.allowlist } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to read startup config' } };
    }
  });

  ipcMain.handle('api:setStartupConfig', async (_evt, payload: { threshold: number; allowlist: string[] }): Promise<IpcResult<{}>> => {
    try {
      const { writeStartupConfig } = await import('./startupConfig.js');
      writeStartupConfig(payload.threshold, payload.allowlist);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_VALIDATION', message: e?.message ?? 'Invalid startup config' } };
    }
  });

  // v2.4.13: NAS drive enumeration. Backs the Dashboard NasRecycleBinPanel.
  // Returns [{letter, unc, used/free/total/recycle bytes, reachable}] per
  // DriveType=4 logical disk. Offline shares come back with reachable=false
  // and null numeric fields so the UI can render them grayed out.
  // v2.4.28: aggregated CPU + GPU + NVMe temperature reading for the
  // Dashboard TemperaturePanel. Non-admin: GPU via nvidia-smi works,
  // NVMe via SMART cache works, CPU needs admin (marked needs_admin).
  ipcMain.handle('api:getTemperatures', async (): Promise<IpcResult<any>> => {
    try {
      const { runPowerShellScript } = await import('./scriptRunner.js');
      const r = await runPowerShellScript<any>('Get-Temperatures.ps1', ['-JsonOutput'], { timeoutMs: 15_000 });
      return { ok: true, data: r };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Failed to read temperatures' } };
    }
  });

  ipcMain.handle('api:getNasDrives', async (): Promise<IpcResult<Array<{ letter: string; unc: string | null; volume_name: string | null; kind: 'network' | 'local' | 'removable'; used_bytes: number | null; free_bytes: number | null; total_bytes: number | null; recycle_bytes: number | null; recycle_bytes_cache_age_ms: number | null; reachable: boolean }>>> => {
    try {
      const { runPowerShellScript } = await import('./scriptRunner.js');
      // v2.4.51 (B49-NAS-2): drain any pending JSON queue files left by the
      // Refresh-NasRecycleSizes.ps1 scheduled task before reading the cache.
      // The PS task drops queue files when the in-app node bridge isn't
      // reachable (e.g. during a scheduled run while Workbench was closed);
      // the next IPC call upserts rows into nas_recycle_sizes.
      await drainNasRecycleQueue();
      const r = await runPowerShellScript<{ drives?: Array<{ letter: string; unc: string | null; volume_name: string | null; kind: 'network' | 'local' | 'removable'; used_bytes: number | null; free_bytes: number | null; total_bytes: number | null; recycle_bytes: number | null; reachable: boolean }> }>('Get-NasDrives.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
      const drives = r?.drives ?? [];
      // v2.4.51 (B49-NAS-2): merge cached @Recycle sizes from
      // nas_recycle_sizes. Get-NasDrives.ps1 still emits recycle_bytes:null
      // per the v2.4.50 hot-path fix; the cache fills it in when fresh.
      // recycle_bytes_cache_age_ms = null when no cache row exists.
      const cache = getNasRecycleSizes();
      const now = Date.now();
      const enriched = drives.map(d => {
        const cached = cache.get(d.letter.toUpperCase());
        if (cached) {
          return { ...d, recycle_bytes: cached.recycle_bytes, recycle_bytes_cache_age_ms: now - cached.last_scanned_ts };
        }
        return { ...d, recycle_bytes_cache_age_ms: null };
      });
      return { ok: true, data: enriched };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Failed to enumerate drives' } };
    }
  });

  // v2.4.6: Event Log errors chart click-to-expand fetches this breakdown
  // on demand (not part of the scheduled scan — cheap enough to run
  // interactively, stale data in the main scan report was misleading
  // anyway since the 7-day window slides forward continuously).
  ipcMain.handle('api:getEventLogBreakdown', async (_evt, opts: { days?: number; topN?: number; level?: string }): Promise<IpcResult<any>> => {
    try {
      const { runPowerShellScript } = await import('./scriptRunner.js');
      // v2.4.10: validate inputs. Even though scriptRunner uses execFile
      // (array-form spawn — no shell interpolation), PS-side code still
      // parses these. Out-of-range days would bog down the WinEvent query;
      // unrecognised level strings would throw late. Reject here with a
      // clear error rather than letting bad values flow through.
      const args = ['-JsonOutput'];
      if (opts?.days !== undefined) {
        const d = Number(opts.days);
        if (!Number.isInteger(d) || d < 1 || d > 90) {
          return { ok: false, error: { code: 'E_VALIDATION', message: 'days must be an integer between 1 and 90' } };
        }
        args.push('-Days', String(d));
      }
      if (opts?.topN !== undefined) {
        const n = Number(opts.topN);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return { ok: false, error: { code: 'E_VALIDATION', message: 'topN must be an integer between 1 and 100' } };
        }
        args.push('-TopN', String(n));
      }
      if (opts?.level !== undefined) {
        // PS script accepts '2' (Error) or '2,3' (Error+Warning).
        // Reject anything else to avoid surprising WinEvent filter behaviour.
        if (opts.level !== '2' && opts.level !== '2,3' && opts.level !== '3') {
          return { ok: false, error: { code: 'E_VALIDATION', message: "level must be one of: '2' (Error), '3' (Warning), '2,3' (both)" } };
        }
        args.push('-Level', opts.level);
      }
      const r = await runPowerShellScript<any>('Get-EventLogBreakdown.ps1', args, { timeoutMs: 45_000 });
      return { ok: true, data: r };
    } catch (e: any) {
      return { ok: false, error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Failed to read Event Log breakdown' } };
    }
  });

  // v2.4.38: renderer-side perf telemetry. Fire-and-forget; renderer
  // uses ipcRenderer.send (not invoke) so there is no response. Every
  // input from the renderer goes through validation before touching the
  // filesystem to prevent log injection -- phase is clamped, duration is
  // coerced, and extra is restricted to a flat object of primitives.
  ipcMain.on('api:logRenderPerf', (_evt, raw: unknown) => {
    try {
      const sanitized = sanitizeRenderPerfInput(raw);
      if (!sanitized) return;
      void writeRenderPerfLine(sanitized.phase, sanitized.duration, sanitized.extra);
    } catch { /* telemetry must never throw */ }
  });

  // v2.5.2: open LibreHardwareMonitor when the Dashboard banner reports
  // the Remote Web Server is unreachable. Greg's box has LHM installed
  // via WinGet (folder hash suffix can change after updates), so we
  // try a hardcoded path first, then fall back to discovery via
  // Get-Process. shell.openPath routes through ShellExecuteW which
  // brings an already-running LHM window to the foreground.
  ipcMain.handle('api:openLhm', async (): Promise<IpcResult<{ path: string; action?: string }>> => {
    try {
      // v2.5.3: try the show-window helper first. If LHM is running but
      // tray-hidden (Greg's "Minimize To Tray" config), shell.openPath
      // hits the single-instance mutex and the user sees nothing — the
      // helper walks EnumWindows, finds LHM's hidden top-level windows,
      // and ShowWindow(SW_RESTORE) + SetForegroundWindow them.
      try {
        const { runPowerShellScript } = await import('./scriptRunner.js');
        const r = await runPowerShellScript<any>('Show-LhmWindow.ps1', [], { timeoutMs: 5_000 });
        if (r?.ok === true) {
          return { ok: true, data: { path: 'running', action: r.action } };
        }
        // r?.ok === false → either 'not_running' or 'no_windows' or
        // 'ps_unhandled'. Fall through to the launch path below.
      } catch {
        // Helper script crashed or timed out. Fall through to launch.
      }

      // Launch path: LHM is not running (or the show-window helper
      // failed for an unrelated reason). Resolve a candidate exe and
      // shell.openPath it.
      const candidates = await resolveLhmCandidatePaths();
      for (const candidate of candidates) {
        if (existsSync(candidate)) {
          const errMsg = await shell.openPath(candidate);
          if (errMsg === '') {
            return { ok: true, data: { path: candidate, action: 'launched' } };
          }
          // Try the next candidate if shell.openPath rejected this one
          // (e.g. file exists but ACLs deny launch).
        }
      }
      return { ok: false, error: { code: 'E_LHM_NOT_FOUND', message: 'LibreHardwareMonitor.exe could not be located. Install via WinGet (LibreHardwareMonitor.LibreHardwareMonitor) or set the path manually.' } };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to open LHM' } };
    }
  });
}

/**
 * v2.5.2: build an ordered list of candidate LHM exe paths to try.
 *
 * Order:
 *   1. Greg's WinGet install (current at v2.5.2 ship date).
 *   2. The same WinGet folder pattern with any version-suffix (glob the
 *      _Microsoft.Winget.Source_8wekyb3d8bbwe* parent so a future
 *      LHM update doesn't break the link).
 *   3. Standard Program Files install path.
 *   4. Live Get-Process LibreHardwareMonitor lookup — the most-correct
 *      answer when LHM is actually running.
 */
async function resolveLhmCandidatePaths(): Promise<string[]> {
  const out: string[] = [];
  // v2.5.2 (code-reviewer W3): the previous version hardcoded
  // `C:\Users\greg_\...` as candidate 0. That dead-misses on every other
  // user account, so we use `app.getPath('home')` instead — which on
  // Windows resolves to %USERPROFILE% (correct for any logged-in user).
  // Greg's box still hits because his home is C:\Users\greg_.
  const wingetDefault = path.join(
    app.getPath('home'),
    'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages',
    'LibreHardwareMonitor.LibreHardwareMonitor_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'LibreHardwareMonitor.exe',
  );
  out.push(wingetDefault);

  // WinGet folder hash usually stays stable but the folder can carry a
  // version suffix on newer manifests. Scan the WinGet packages dir for
  // any LibreHardwareMonitor* folder that contains the .exe.
  try {
    const wingetParent = path.join(app.getPath('home'), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages');
    if (existsSync(wingetParent)) {
      const entries = await readdir(wingetParent);
      for (const dir of entries) {
        if (!dir.startsWith('LibreHardwareMonitor')) continue;
        const cand = path.join(wingetParent, dir, 'LibreHardwareMonitor.exe');
        if (cand !== wingetDefault) out.push(cand);
      }
    }
  } catch { /* directory walk failures are non-fatal — we fall through */ }

  out.push('C:\\Program Files\\LibreHardwareMonitor\\LibreHardwareMonitor.exe');

  // Live process lookup. Cheaper than spawning powershell — wmic is
  // legacy but still installed on Windows 11 home builds; we don't
  // depend on it being present.
  try {
    const r = await pExecFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      "(Get-Process LibreHardwareMonitor -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
    ], { timeout: 3000 });
    const live = (r.stdout || '').trim();
    if (live && existsSync(live)) out.push(live);
  } catch { /* no running LHM process is the expected case here */ }

  return out;
}

/** v2.5.2: test hook -- exposes resolveLhmCandidatePaths for unit tests.
 *  Callers mock electron/app, node:fs, node:fs/promises, and node:child_process
 *  to drive candidate-list scenarios without spawning real processes. */
export const _resolveLhmCandidatePathsForTests = resolveLhmCandidatePaths;

/** Pure validation helper for the api:logRenderPerf IPC payload. Exported for unit testing. */
export function sanitizeRenderPerfInput(raw: unknown): {
  phase: string;
  duration: number;
  extra: Record<string, unknown> | undefined;
} | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const phase = typeof r.phase === 'string' ? r.phase.slice(0, 64) : 'unknown';
  const duration = typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms) ? r.duration_ms : 0;
  let extra: Record<string, unknown> | undefined;
  if (r.extra && typeof r.extra === 'object' && !Array.isArray(r.extra)) {
    const e = r.extra as Record<string, unknown>;
    extra = {};
    // Only keep primitive values; strip nested objects / arrays.
    for (const [k, v] of Object.entries(e)) {
      if (typeof v === 'string') extra[k] = v.slice(0, 256);
      else if (typeof v === 'number' || typeof v === 'boolean') extra[k] = v;
    }
  }
  return { phase, duration, extra };
}
