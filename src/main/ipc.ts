import { ipcMain } from 'electron';
import { getStatus, PCDoctorBridgeError } from './pcdoctorBridge.js';
import { runAction } from './actionRunner.js';
import type { ActionName, IpcResult, SystemStatus, ActionResult } from '@shared/types.js';

export function registerIpcHandlers() {
  ipcMain.handle('api:getStatus', async (): Promise<IpcResult<SystemStatus>> => {
    try {
      const data = await getStatus();
      return { ok: true, data };
    } catch (e) {
      const err = e as PCDoctorBridgeError;
      return {
        ok: false,
        error: {
          code: err.code ?? 'E_INTERNAL',
          message: err.message ?? 'Failed to read status',
        },
      };
    }
  });

  ipcMain.handle('api:runAction', async (_evt, name: ActionName): Promise<IpcResult<ActionResult>> => {
    try {
      const result = await runAction(name);
      return { ok: true, data: result };
    } catch (e: any) {
      return { ok: false, error: { code: 'E_INTERNAL', message: e?.message ?? 'Action failed' } };
    }
  });
}
