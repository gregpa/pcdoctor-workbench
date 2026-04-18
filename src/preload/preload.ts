import { contextBridge, ipcRenderer } from 'electron';
import type {
  IpcResult, SystemStatus, ActionResult,
  AuditLogEntry, RunActionRequest, RevertResult, Trend, ForecastData, WeeklyReview,
  SecurityPosture, ToolStatus,
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
  getSettings: (): Promise<IpcResult<Record<string, string>>> => ipcRenderer.invoke('api:getSettings'),
  setSetting: (key: string, value: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:setSetting', key, value),
  testTelegram: (token: string, chatId: string): Promise<IpcResult<{ bot_username?: string }>> => ipcRenderer.invoke('api:testTelegram', token, chatId),
  sendTestNotification: (): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:sendTestNotification'),
};

contextBridge.exposeInMainWorld('api', api);

export type WorkbenchApi = typeof api;
