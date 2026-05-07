import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, ToolStatus, ScheduledTaskInfo, SystemProfile, ServiceRow,
  ProcessRow, ProcessPriorityClass, ProcessDetail,
} from '@shared/types.js';

const api = {
  getAppVersion: (): Promise<IpcResult<string>> => ipcRenderer.invoke('api:getAppVersion'),
  setZoom: (delta: number): Promise<IpcResult<number>> => ipcRenderer.invoke('api:setZoom', delta),
  getZoom: (): Promise<IpcResult<number>> => ipcRenderer.invoke('api:getZoom'),
  writeClipboard: (text: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:writeClipboard', text),
  saveActionResult: (actionName: string, ts: number, body: string): Promise<IpcResult<{ path: string }>> => ipcRenderer.invoke('api:saveActionResult', actionName, ts, body),
  getToolUpdates: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getToolUpdates'),
  refreshToolUpdates: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:refreshToolUpdates'),
  upgradeTool: (wingetId: string): Promise<IpcResult<any>> => ipcRenderer.invoke('api:upgradeTool', wingetId),
  upgradeAllTools: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:upgradeAllTools'),
  getLastActionSuccessMap: (): Promise<IpcResult<Record<string, number>>> => ipcRenderer.invoke('api:getLastActionSuccessMap'),
  getLastActionResult: (action_name: string): Promise<IpcResult<{ ts: number; result: any } | null>> => ipcRenderer.invoke('api:getLastActionResult', action_name),
  getStatus: (): Promise<IpcResult<SystemStatus>> => ipcRenderer.invoke('api:getStatus'),
  runAction: (req: RunActionRequest): Promise<IpcResult<ActionResult>> => ipcRenderer.invoke('api:runAction', req),
  getAuditLog: (limit?: number): Promise<IpcResult<AuditLogEntry[]>> => ipcRenderer.invoke('api:getAuditLog', limit ?? 200),
  revertAction: (auditId: number): Promise<IpcResult<RevertResult>> => ipcRenderer.invoke('api:revertAction', auditId),
  getTrend: (req: { category: string; metric: string; days: number }): Promise<IpcResult<Trend>> =>
    ipcRenderer.invoke('api:getTrend', req),
  getForecast: (): Promise<IpcResult<ForecastData>> => ipcRenderer.invoke('api:getForecast'),
  regenerateForecast: (): Promise<IpcResult<ForecastData>> => ipcRenderer.invoke('api:regenerateForecast'),
  getWeeklyReview: (reviewDate?: string): Promise<IpcResult<WeeklyReview | null>> => ipcRenderer.invoke('api:getWeeklyReview', reviewDate),
  listWeeklyReviews: (): Promise<IpcResult<string[]>> => ipcRenderer.invoke('api:listWeeklyReviews'),
  setWeeklyReviewItemState: (reviewDate: string, itemId: string, state: string, appliedActionId?: number): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:setWeeklyReviewItemState', reviewDate, itemId, state, appliedActionId),
  archiveWeeklyReviewToObsidian: (reviewDate: string): Promise<IpcResult<{ archive_path: string }>> => ipcRenderer.invoke('api:archiveWeeklyReviewToObsidian', reviewDate),
  dismissWeeklyReviewFlag: (): Promise<IpcResult<void>> => ipcRenderer.invoke('api:dismissWeeklyReviewFlag'),
  getSecurityPosture: (): Promise<IpcResult<SecurityPosture>> => ipcRenderer.invoke('api:getSecurityPosture'),
  approvePersistence: (identifier: string, approve: boolean): Promise<IpcResult<void>> => ipcRenderer.invoke('api:approvePersistence', identifier, approve),
  listTools: (): Promise<IpcResult<ToolStatus[]>> => ipcRenderer.invoke('api:listTools'),
  launchTool: (toolId: string, modeId: string): Promise<IpcResult<{ pid?: number }>> => ipcRenderer.invoke('api:launchTool', toolId, modeId),
  installTool: (toolId: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:installTool', toolId),
  getWindowsUpdateDetail: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getWindowsUpdateDetail'),
  getDefenderScanStatus: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getDefenderScanStatus'),
  listAutopilotRules: (): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:listAutopilotRules'),
  getAutopilotActivity: (daysBack?: number): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:getAutopilotActivity', daysBack ?? 30),
  suppressAutopilotRule: (ruleId: string, hours: number): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:suppressAutopilotRule', ruleId, hours),
  // v2.3.0 C2: autopilot rule editor
  setAutopilotRuleEnabled: (ruleId: string, enabled: boolean): Promise<IpcResult<{}>> =>
    ipcRenderer.invoke('api:setAutopilotRuleEnabled', ruleId, enabled),
  runAutopilotRuleNow: (ruleId: string): Promise<IpcResult<{ outcome: string; message?: string }>> =>
    ipcRenderer.invoke('api:runAutopilotRuleNow', ruleId),
  exportAutopilotRules: (): Promise<IpcResult<{ rules: any[] }>> =>
    ipcRenderer.invoke('api:exportAutopilotRules'),
  importAutopilotRules: (payload: { rules: any[] }): Promise<IpcResult<{ imported: number }>> =>
    ipcRenderer.invoke('api:importAutopilotRules', payload),
  getFeatureUpgradeReadiness: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getFeatureUpgradeReadiness'),
  getNvidiaDriverLatest: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getNvidiaDriverLatest'),
  getClaudeStatus: (): Promise<IpcResult<{ installed: boolean; path: string | null }>> => ipcRenderer.invoke('api:getClaudeStatus'),
  launchClaude: (): Promise<IpcResult<{ pid?: number }>> => ipcRenderer.invoke('api:launchClaude'),
  investigateWithClaude: (contextText: string): Promise<IpcResult<{ pid?: number }>> => ipcRenderer.invoke('api:investigateWithClaude', contextText),
  onClaudeApprovalRequest: (cb: (req: { id: string; action: string; params?: any; context?: string }) => void) => {
    const handler = (_evt: any, req: any) => cb(req);
    ipcRenderer.on('claude-approval-request', handler);
    return () => ipcRenderer.removeListener('claude-approval-request', handler);
  },
  sendClaudeApproval: (id: string, approved: boolean) => ipcRenderer.send(`claude-approval-response-${id}`, approved),
  getSettings: (): Promise<IpcResult<Record<string, string>>> => ipcRenderer.invoke('api:getSettings'),
  setSetting: (key: string, value: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:setSetting', key, value),
  revealTelegramToken: (): Promise<IpcResult<{ token: string }>> => ipcRenderer.invoke('api:revealTelegramToken'),
  testTelegram: (token: string, chatId: string): Promise<IpcResult<{ bot_username?: string }>> => ipcRenderer.invoke('api:testTelegram', token, chatId),
  sendTestNotification: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:sendTestNotification'),
  sendTelegramTestFull: (): Promise<IpcResult<{ sent_at: number }>> => ipcRenderer.invoke('api:sendTelegramTestFull'),
  listScheduledTasks: (): Promise<IpcResult<ScheduledTaskInfo[]>> => ipcRenderer.invoke('api:listScheduledTasks'),
  setScheduledTaskEnabled: (name: string, enabled: boolean): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:setScheduledTaskEnabled', name, enabled),
  runScheduledTaskNow: (name: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:runScheduledTaskNow', name),
  exportDiagnosticBundle: (): Promise<IpcResult<{ path: string; size_kb: number }>> => ipcRenderer.invoke('api:exportDiagnosticBundle'),
  exportClaudeReport: (): Promise<IpcResult<{ markdown: string; line_count: number; byte_count: number; file_path: string; generated_at: number }>> => ipcRenderer.invoke('api:exportClaudeReport'),
  flushBufferedNotifications: (): Promise<IpcResult<{ sent: number }>> => ipcRenderer.invoke('api:flushBufferedNotifications'),
  sendWeeklyDigestEmail: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:sendWeeklyDigestEmail'),
  getRecentAuthEvents: (): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:getRecentAuthEvents'),
  listBlockedIPs: (): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:listBlockedIPs'),
  listToolResults: (toolId?: string): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:listToolResults', toolId),
  getUpdateStatus: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getUpdateStatus'),
  checkForUpdates: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:checkForUpdates'),
  downloadUpdate: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:downloadUpdate'),
  installUpdateNow: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:installUpdateNow'),
  // v2.4.6: NAS config read/write for Settings page.
  getNasConfig: (): Promise<IpcResult<{ nas_server: string; nas_mappings: Array<{ drive: string; share: string }> }>> =>
    ipcRenderer.invoke('api:getNasConfig'),
  setNasConfig: (payload: { nas_server: string; nas_mappings: Array<{ drive: string; share: string }> }): Promise<IpcResult<{}>> =>
    ipcRenderer.invoke('api:setNasConfig', payload),
  // v2.4.13: Startup config (threshold + allowlist) for StartupPickerModal.
  getStartupConfig: (): Promise<IpcResult<{ threshold: number; allowlist: string[] }>> =>
    ipcRenderer.invoke('api:getStartupConfig'),
  setStartupConfig: (payload: { threshold: number; allowlist: string[] }): Promise<IpcResult<{}>> =>
    ipcRenderer.invoke('api:setStartupConfig', payload),
  // v2.4.13 (v2.4.14 expanded): all-drive enumeration for Dashboard
  // NasRecycleBinPanel. kind='network'|'local'|'removable'. Local +
  // removable drives leave unc=null + recycle_bytes=null (UI hides trash).
  getNasDrives: (): Promise<IpcResult<Array<{ letter: string; unc: string | null; volume_name: string | null; kind: 'network' | 'local' | 'removable'; used_bytes: number | null; free_bytes: number | null; total_bytes: number | null; recycle_bytes: number | null; reachable: boolean }>>> =>
    ipcRenderer.invoke('api:getNasDrives'),
  // v2.4.28: CPU + GPU + NVMe temperature aggregation.
  getTemperatures: (): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:getTemperatures'),
  // v2.4.6: on-demand Event Log breakdown for the chart click-to-expand.
  getEventLogBreakdown: (opts?: { days?: number; topN?: number; level?: string }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:getEventLogBreakdown', opts ?? {}),
  // v2.4.38: renderer-side perf telemetry. Fire-and-forget (no Promise) so
  // calling sites never block on the IPC round-trip. Main process appends
  // to C:\ProgramData\PCDoctor\logs\render-perf-YYYYMMDD.log.
  logRenderPerf: (phase: string, durationMs: number, extra?: Record<string, string | number | boolean>): void => {
    try {
      ipcRenderer.send('api:logRenderPerf', { phase, duration_ms: durationMs, extra });
    } catch { /* telemetry must never throw */ }
  },
  // v2.5.2: launch LibreHardwareMonitor from the Dashboard "Remote Web
  // Server is off" banner. Main-side resolves the install path via
  // hardcoded WinGet default + glob fallback + live Get-Process lookup.
  openLhm: (): Promise<IpcResult<{ path: string }>> => ipcRenderer.invoke('api:openLhm'),
  // v2.5.38: enable LHM's Remote Web Server automatically (kill, edit
  // config, relaunch, probe localhost:8085).
  enableLhmRemoteWebServer: (): Promise<IpcResult<{
    exe_path: string; config_path: string; was_running: boolean;
    was_already_enabled: boolean; port: number; http_check: string;
  }>> => ipcRenderer.invoke('api:enableLhmRemoteWebServer'),
  // v2.5.17 (first-run wizard W5): fire Invoke-PCDoctor.ps1 -Mode Report in
  // the background so the dashboard has data on first launch. Fire-and-forget.
  triggerInitialScan: (): Promise<IpcResult<null>> => ipcRenderer.invoke('api:triggerInitialScan'),
  // v2.6.0 (wizard W2): system hardware profile for the first-run wizard.
  getSystemProfile: (): Promise<IpcResult<SystemProfile>> => ipcRenderer.invoke('api:getSystemProfile'),
  // v2.5.30: Services page data (full enumerate, ~250 rows). Distinct from
  // SystemStatus.services (curated 10-row health view on Dashboard).
  listAllServices: (): Promise<IpcResult<ServiceRow[]>> => ipcRenderer.invoke('api:listAllServices'),
  // v2.5.30: service mutate handlers. dryRun=true returns projected
  // before/after for the renderer's confirm dialog without DB writes; the
  // real run persists to actions_log + rollbacks for the 7-day undo path.
  setServiceStartup: (
    service: string,
    startupType: 'Automatic' | 'AutomaticDelayedStart' | 'Manual' | 'Disabled',
    opts?: { dryRun?: boolean },
  ): Promise<IpcResult<any>> => ipcRenderer.invoke('api:setServiceStartup', service, startupType, opts),
  stopService: (service: string, opts?: { dryRun?: boolean }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:stopService', service, opts),
  startService: (service: string, opts?: { dryRun?: boolean }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:startService', service, opts),
  undoServiceAction: (actionLogId: number): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:undoServiceAction', actionLogId),
  // v2.5.30 (P1-P3): Processes page bridges.
  listAllProcesses: (): Promise<IpcResult<ProcessRow[]>> =>
    ipcRenderer.invoke('api:listAllProcesses'),
  // v2.5.34: rich detail for one PID (powers RamPressurePanel inspect modal)
  getProcessDetail: (pid: number): Promise<IpcResult<ProcessDetail>> =>
    ipcRenderer.invoke('api:getProcessDetail', pid),
  killProcess: (target: number | string, opts?: { dryRun?: boolean }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:killProcess', target, opts),
  setProcessPriority: (
    pid: number, priorityClass: ProcessPriorityClass, opts?: { dryRun?: boolean },
  ): Promise<IpcResult<any>> => ipcRenderer.invoke('api:setProcessPriority', pid, priorityClass, opts),
  setProcessAffinity: (
    pid: number, mask: number, opts?: { dryRun?: boolean },
  ): Promise<IpcResult<any>> => ipcRenderer.invoke('api:setProcessAffinity', pid, mask, opts),
  suspendProcess: (pid: number, opts?: { dryRun?: boolean }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:suspendProcess', pid, opts),
  resumeProcess: (pid: number, opts?: { dryRun?: boolean }): Promise<IpcResult<any>> =>
    ipcRenderer.invoke('api:resumeProcess', pid, opts),

  // v2.5.30 (S6): UndoCenter feed. Lists undoable service actions whose
  // rollback row is still within the 7-day TTL.
  listUndoableServiceActions: (): Promise<IpcResult<{
    rows: Array<{
      action_id: number;
      rollback_id: number;
      ts: number;
      action_name: string;
      action_label: string;
      expires_at: number;
      service: string | null;
    }>;
    server_now: number;
  }>> => ipcRenderer.invoke('api:listUndoableServiceActions'),
  claudePty: {
    available: (): Promise<{ available: boolean; error?: string }> =>
      ipcRenderer.invoke('api:claudePty:available'),
    spawn: (opts: { id: string; contextText?: string; cols?: number; rows?: number }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('api:claudePty:spawn', opts),
    write: (id: string, data: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('api:claudePty:write', { id, data }),
    resize: (id: string, cols: number, rows: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('api:claudePty:resize', { id, cols, rows }),
    kill: (id: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('api:claudePty:kill', id),
    onData: (id: string, cb: (chunk: string) => void): (() => void) => {
      const channel = `claudePty:data:${id}`;
      const handler = (_e: any, d: string) => cb(d);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onExit: (id: string, cb: (info: { exitCode: number }) => void): (() => void) => {
      const channel = `claudePty:exit:${id}`;
      const handler = (_e: any, info: any) => cb(info);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
};

contextBridge.exposeInMainWorld('api', api);

export type WorkbenchApi = typeof api;
