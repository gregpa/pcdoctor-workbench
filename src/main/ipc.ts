import { ipcMain, safeStorage } from 'electron';
import { readFile, readdir, unlink, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { spawnSync } from 'node:child_process';
import { getStatus, PCDoctorBridgeError, setCachedSmart } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import { revertRollback } from './rollbackManager.js';
import {
  listActionLog, markActionReverted, queryMetricTrend, loadForecasts,
  upsertPersistence, setPersistenceApproval, countNewPersistence,
  setSetting, getAllSettings, getSetting,
  setReviewItemState, getReviewItemStates,
  listToolResults,
} from './dataStore.js';
import { generateForecasts } from './forecastEngine.js';
import { runPowerShellScript } from './scriptRunner.js';
import { PCDOCTOR_ROOT } from './constants.js';
import { listAllToolStatuses, launchTool, installToolViaWinget } from './toolLauncher.js';
import { launchClaudeInTerminal, launchClaudeWithContext, resolveClaudePath } from './claudeBridge.js';
import { checkForUpdates, downloadUpdate, installNow, getStatus as getUpdaterStatus } from './autoUpdater.js';
import type { UpdateStatus } from './autoUpdater.js';
import { testTelegramConnection, sendTelegramMessage } from './telegramBridge.js';
import { flushBufferedNotifications } from './notifier.js';
import { sendWeeklyDigestEmail } from './emailDigest.js';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, PersistenceItem, ThreatIndicator, ToolStatus, ScheduledTaskInfo,
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

  ipcMain.handle('api:getWeeklyReview', async (_evt, reviewDate?: string): Promise<IpcResult<WeeklyReview | null>> => {
    try {
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
    try {
      setReviewItemState(reviewDate, itemId, state as any, appliedActionId);
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:archiveWeeklyReviewToObsidian', async (_evt, reviewDate: string): Promise<IpcResult<{ archive_path: string }>> => {
    try {
      const sourceMd = path.join(weeklyDir, `${reviewDate}.md`);
      if (!existsSync(sourceMd)) return { ok: false, error: { code: 'E_NOT_FOUND', message: 'Review markdown not found' } };
      const obsidianDir = path.join('C:', 'Users', 'greg_', 'Documents', 'Claude Cowork', 'Obsidian Vault', 'PC Doctor', 'Weekly Reviews');
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
      const posture = await runPowerShellScript<any>('security/Get-SecurityPosture.ps1', ['-JsonOutput'], { timeoutMs: 120_000 });
      const audit = await runPowerShellScript<any>('security/Audit-Persistence.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ items: [] }));
      const threats = await runPowerShellScript<any>('security/Get-ThreatIndicators.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ indicators: [] }));
      const smart = await runPowerShellScript<any>('security/Get-SMART.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ drives: [] }));

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
        })),
        overall_severity: posture.overall_severity ?? 'good',
      };
      setCachedSmart(data.smart);

      // Auto-block RDP brute-force source IPs if setting enabled
      const autoBlockEnabled = getSetting('auto_block_rdp_bruteforce') === '1';
      if (autoBlockEnabled) {
        for (const ti of data.threat_indicators) {
          if (ti.category === 'rdp_bruteforce' && (ti.detail as any)?.auto_block_candidates) {
            for (const ip of ((ti.detail as any).auto_block_candidates as string[])) {
              try {
                await runPowerShellScript('actions/Block-IP.ps1', ['-JsonOutput', '-Ip', ip, '-Reason', 'Auto-block: RDP brute-force'], { timeoutMs: 10_000 });
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
    const r = await installToolViaWinget(toolId);
    if (r.ok) return { ok: true, data: {} };
    return { ok: false, error: { code: 'E_TOOL_INSTALL', message: r.error ?? 'Install failed' } };
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
      // Decrypt sensitive values before returning
      for (const k of ['telegram_bot_token']) {
        const v = all[k];
        if (v?.startsWith('dpapi:') && safeStorage.isEncryptionAvailable()) {
          try {
            const ct = Buffer.from(v.slice(6), 'base64');
            all[k] = safeStorage.decryptString(ct);
          } catch { all[k] = ''; }
        }
      }
      return { ok: true, data: all };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:setSetting', async (_evt, key: string, value: string): Promise<IpcResult<{}>> => {
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
    const r = await sendTelegramMessage('🧪 <b>Test notification from PCDoctor Workbench</b>\n\nThis is a manual test — ignore.');
    if (r.ok) return { ok: true, data: {} };
    return { ok: false, error: { code: 'E_TG_SEND', message: r.error ?? 'send failed' } };
  });

  ipcMain.handle('api:listScheduledTasks', async (): Promise<IpcResult<ScheduledTaskInfo[]>> => {
    try {
      const tasks = ['PCDoctor-Workbench-Autostart','PCDoctor-Daily-Quick','PCDoctor-Weekly','PCDoctor-Weekly-Review','PCDoctor-Forecast','PCDoctor-Security-Daily','PCDoctor-Security-Weekly','PCDoctor-Prune-Rollbacks','PCDoctor-Monthly-Deep'];
      const result: ScheduledTaskInfo[] = [];
      for (const name of tasks) {
        const r = spawnSync('schtasks.exe', ['/Query', '/TN', name, '/FO', 'CSV', '/V'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        if (r.status !== 0) { result.push({ name, status: 'Not registered', next_run: null, last_run: null, last_result: null }); continue; }
        const lines = (r.stdout ?? '').split(/\r?\n/).filter(Boolean);
        if (lines.length < 2) { result.push({ name, status: 'Unknown', next_run: null, last_run: null, last_result: null }); continue; }
        const headers = lines[0].replace(/^"|"$/g, '').split('","');
        const values = lines[1].replace(/^"|"$/g, '').split('","');
        const map: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) map[headers[i]] = values[i] ?? '';
        result.push({
          name,
          status: map['Status'] ?? map['Scheduled Task State'] ?? 'Unknown',
          next_run: map['Next Run Time'] ?? null,
          last_run: map['Last Run Time'] ?? null,
          last_result: map['Last Result'] ?? null,
        });
      }
      return { ok: true, data: result };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:setScheduledTaskEnabled', async (_evt, name: string, enabled: boolean): Promise<IpcResult<{}>> => {
    try {
      const r = spawnSync('schtasks.exe', ['/Change', '/TN', name, enabled ? '/ENABLE' : '/DISABLE'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0) return { ok: false, error: { code: 'E_SCHTASKS', message: r.stderr || 'schtasks failed' } };
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
    }
  });

  ipcMain.handle('api:runScheduledTaskNow', async (_evt, name: string): Promise<IpcResult<{}>> => {
    try {
      const r = spawnSync('schtasks.exe', ['/Run', '/TN', name], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0) return { ok: false, error: { code: 'E_SCHTASKS', message: r.stderr || 'schtasks failed' } };
      return { ok: true, data: {} };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message } };
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

  ipcMain.handle('api:getUpdateStatus', async (): Promise<IpcResult<UpdateStatus>> => {
    return { ok: true, data: getUpdaterStatus() };
  });

  ipcMain.handle('api:checkForUpdates', async (): Promise<IpcResult<UpdateStatus>> => {
    await checkForUpdates();
    return { ok: true, data: getUpdaterStatus() };
  });

  ipcMain.handle('api:downloadUpdate', async (): Promise<IpcResult<UpdateStatus>> => {
    await downloadUpdate();
    return { ok: true, data: getUpdaterStatus() };
  });

  ipcMain.handle('api:installUpdateNow', async (): Promise<IpcResult<{}>> => {
    installNow();
    return { ok: true, data: {} };
  });
}
