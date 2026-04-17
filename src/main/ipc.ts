import { ipcMain } from 'electron';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { getStatus, PCDoctorBridgeError } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import { revertRollback } from './rollbackManager.js';
import {
  listActionLog, markActionReverted, queryMetricTrend, loadForecasts,
  upsertPersistence, setPersistenceApproval, countNewPersistence,
} from './dataStore.js';
import { generateForecasts } from './forecastEngine.js';
import { runPowerShellScript } from './scriptRunner.js';
import { PCDOCTOR_ROOT } from './constants.js';
import { listAllToolStatuses, launchTool, installToolViaWinget } from './toolLauncher.js';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, PersistenceItem, ThreatIndicator, ToolStatus,
} from '@shared/types.js';

const weeklyDir = path.join(PCDOCTOR_ROOT, 'reports', 'weekly');

export function registerIpcHandlers() {
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
      const result = await runAction({ name: req.name, params: req.params });
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
      const log = listActionLog(500).find((r) => r.id === auditId);
      if (!log) return { ok: false, error: { code: 'E_INTERNAL', message: 'Action not found' } };
      if (!log.rollback_id) return { ok: false, error: { code: 'E_INTERNAL', message: 'This action has no rollback record' } };

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

  ipcMain.handle('api:getWeeklyReview', async (): Promise<IpcResult<WeeklyReview | null>> => {
    try {
      if (!existsSync(weeklyDir)) return { ok: true, data: null };
      const files = (await readdir(weeklyDir)).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length === 0) return { ok: true, data: null };
      const latestFile = path.join(weeklyDir, files[0]);
      let raw = await readFile(latestFile, 'utf8');
      if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
      const data = JSON.parse(raw) as WeeklyReview;
      data.has_pending_flag = existsSync(path.join(weeklyDir, '.pending-review'));
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Failed to load weekly review' } };
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
      const posture = await runPowerShellScript<any>('security/Get-SecurityPosture.ps1', ['-JsonOutput'], { timeoutMs: 120_000 });
      const audit = await runPowerShellScript<any>('security/Audit-Persistence.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ items: [] }));
      const threats = await runPowerShellScript<any>('security/Get-ThreatIndicators.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ indicators: [] }));

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
        overall_severity: posture.overall_severity ?? 'good',
      };
      return { ok: true, data };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Security scan failed' } };
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
    const r = await installToolViaWinget(toolId);
    if (r.ok) return { ok: true, data: {} };
    return { ok: false, error: { code: 'E_TOOL_INSTALL', message: r.error ?? 'Install failed' } };
  });
}
