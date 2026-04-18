import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, ToolStatus, ScheduledTaskInfo,
} from '@shared/types.js';

const api = {
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
  testTelegram: (token: string, chatId: string): Promise<IpcResult<{ bot_username?: string }>> => ipcRenderer.invoke('api:testTelegram', token, chatId),
  sendTestNotification: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:sendTestNotification'),
  listScheduledTasks: (): Promise<IpcResult<ScheduledTaskInfo[]>> => ipcRenderer.invoke('api:listScheduledTasks'),
  setScheduledTaskEnabled: (name: string, enabled: boolean): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:setScheduledTaskEnabled', name, enabled),
  runScheduledTaskNow: (name: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:runScheduledTaskNow', name),
  exportDiagnosticBundle: (): Promise<IpcResult<{ path: string; size_kb: number }>> => ipcRenderer.invoke('api:exportDiagnosticBundle'),
  flushBufferedNotifications: (): Promise<IpcResult<{ sent: number }>> => ipcRenderer.invoke('api:flushBufferedNotifications'),
  sendWeeklyDigestEmail: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:sendWeeklyDigestEmail'),
  getRecentAuthEvents: (): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:getRecentAuthEvents'),
  listBlockedIPs: (): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:listBlockedIPs'),
  listToolResults: (toolId?: string): Promise<IpcResult<any[]>> => ipcRenderer.invoke('api:listToolResults', toolId),
  getUpdateStatus: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getUpdateStatus'),
  checkForUpdates: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:checkForUpdates'),
  downloadUpdate: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:downloadUpdate'),
  installUpdateNow: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:installUpdateNow'),
  claudePty: {
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
