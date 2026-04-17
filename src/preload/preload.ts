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
  getWeeklyReview: (): Promise<IpcResult<WeeklyReview | null>> => ipcRenderer.invoke('api:getWeeklyReview'),
  dismissWeeklyReviewFlag: (): Promise<IpcResult<void>> => ipcRenderer.invoke('api:dismissWeeklyReviewFlag'),
  getSecurityPosture: (): Promise<IpcResult<SecurityPosture>> => ipcRenderer.invoke('api:getSecurityPosture'),
  approvePersistence: (identifier: string, approve: boolean): Promise<IpcResult<void>> => ipcRenderer.invoke('api:approvePersistence', identifier, approve),
  listTools: (): Promise<IpcResult<ToolStatus[]>> => ipcRenderer.invoke('api:listTools'),
  launchTool: (toolId: string, modeId: string): Promise<IpcResult<{ pid?: number }>> => ipcRenderer.invoke('api:launchTool', toolId, modeId),
  installTool: (toolId: string): Promise<IpcResult<{}>> => ipcRenderer.invoke('api:installTool', toolId),
  getWindowsUpdateDetail: (): Promise<IpcResult<any>> => ipcRenderer.invoke('api:getWindowsUpdateDetail'),
  getClaudeStatus: (): Promise<IpcResult<{ installed: boolean; path: string | null }>> => ipcRenderer.invoke('api:getClaudeStatus'),
  launchClaude: (): Promise<IpcResult<{ pid?: number }>> => ipcRenderer.invoke('api:launchClaude'),
};

contextBridge.exposeInMainWorld('api', api);

export type WorkbenchApi = typeof api;
