import { ipcMain } from 'electron';
import { getStatus, PCDoctorBridgeError } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import { revertRollback } from './rollbackManager.js';
import { listActionLog, markActionReverted, queryMetricTrend } from './dataStore.js';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend,
} from '@shared/types.js';

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
}
