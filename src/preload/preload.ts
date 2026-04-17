import { contextBridge, ipcRenderer } from 'electron';
import type { ActionName, IpcResult, SystemStatus, ActionResult } from '@shared/types.js';

const api = {
  getStatus: (): Promise<IpcResult<SystemStatus>> => ipcRenderer.invoke('api:getStatus'),
  runAction: (name: ActionName): Promise<IpcResult<ActionResult>> => ipcRenderer.invoke('api:runAction', name),
};

contextBridge.exposeInMainWorld('api', api);

export type WorkbenchApi = typeof api;
