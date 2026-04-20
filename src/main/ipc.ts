import { ipcMain, safeStorage, app } from 'electron';
import { readFile, readdir, unlink, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Windows-quirk: schtasks.exe hangs when invoked directly via spawn/execFile
// from a Node child_process (it expects an attached console and times out
// otherwise — observed under both spawnSync and execFile). Wrapping the call
// in powershell.exe avoids the hang because PowerShell handles the console
// attachment correctly. Every schtasks call below goes through this helper.
const pExecFile = promisify(execFile);

async function runSchtasks(args: string[], timeoutMs = 5000): Promise<{ stdout: string; stderr: string }> {
  const psCmd = ['schtasks', ...args].join(' ');
  return pExecFile(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', psCmd],
    { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 }
  );
}
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
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, PersistenceItem, ThreatIndicator, ToolStatus, ScheduledTaskInfo,
} from '@shared/types.js';

const weeklyDir = path.join(PCDOCTOR_ROOT, 'reports', 'weekly');

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
      // Run all four PS scans in parallel; combined worst-case latency drops
      // from ~300s sequential to ~120s (bounded by the slowest probe).
      const [posture, audit, threats, smart] = await Promise.all([
        runPowerShellScript<any>('security/Get-SecurityPosture.ps1', ['-JsonOutput'], { timeoutMs: 120_000 }),
        runPowerShellScript<any>('security/Audit-Persistence.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ items: [] })),
        runPowerShellScript<any>('security/Get-ThreatIndicators.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ indicators: [] })),
        runPowerShellScript<any>('security/Get-SMART.ps1', ['-JsonOutput'], { timeoutMs: 60_000 }).catch(() => ({ drives: [] })),
      ]);

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
            const ipv4Re = /^(\d{1,3}\.){3}\d{1,3}$/;
            for (const ip of ((ti.detail as any).auto_block_candidates as string[])) {
              // Validate IP format before passing to PowerShell
              if (typeof ip !== 'string' || !ipv4Re.test(ip)) continue;
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
  ]);

  ipcMain.handle('api:listScheduledTasks', async (): Promise<IpcResult<ScheduledTaskInfo[]>> => {
    // Delegate to a single PowerShell script that wraps schtasks.exe one-task-
    // at-a-time. Calling schtasks via Node child_process directly hangs (it
    // expects an attached console). Calling /Query without /TN to enumerate
    // everything also fails on this machine because of a corrupted Microsoft
    // task entry under the root.
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

  ipcMain.handle('api:importAutopilotRules', async (_evt, payload: { rules: any[] }): Promise<IpcResult<{ imported: number }>> => {
    try {
      const { upsertAutopilotRule } = await import('./dataStore.js');
      let imported = 0;
      for (const r of (payload?.rules ?? [])) {
        if (!r || !r.id || !r.tier || !r.description || !r.trigger) continue;
        upsertAutopilotRule({
          id: String(r.id),
          tier: Number(r.tier) as 1 | 2 | 3,
          description: String(r.description),
          trigger: r.trigger === 'schedule' ? 'schedule' : 'threshold',
          cadence: r.cadence ?? null,
          action_name: r.action_name ?? null,
          alert_json: r.alert_json ?? null,
          enabled: r.enabled !== false,
        });
        imported++;
      }
      return { ok: true, data: { imported } };
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
