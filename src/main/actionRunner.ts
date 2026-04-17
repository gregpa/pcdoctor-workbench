import { ACTIONS } from '@shared/actions.js';
import type { ActionName, ActionResult } from '@shared/types.js';
import { runPowerShellScript, PCDoctorScriptError } from './scriptRunner.js';
import { startActionLog, finishActionLog } from './dataStore.js';

export async function runAction(name: ActionName): Promise<ActionResult> {
  const def = ACTIONS[name];
  if (!def) {
    return {
      action: name,
      success: false,
      duration_ms: 0,
      error: { code: 'E_ACTION_UNKNOWN', message: `Unknown action: ${name}` },
    };
  }

  const logId = startActionLog({
    action_name: name,
    action_label: def.label,
    status: 'running',
    triggered_by: 'user',
  });

  const start = Date.now();
  try {
    const result = await runPowerShellScript<Record<string, unknown>>(def.ps_script, ['-JsonOutput']);
    const duration = Date.now() - start;
    finishActionLog(logId, { status: 'success', duration_ms: duration, result });
    return { action: name, success: true, duration_ms: duration, result };
  } catch (e) {
    const duration = Date.now() - start;
    const err = e as PCDoctorScriptError;
    finishActionLog(logId, {
      status: 'error',
      duration_ms: duration,
      error_message: err.message,
    });
    return {
      action: name,
      success: false,
      duration_ms: duration,
      error: { code: err.code ?? 'E_ACTION_FAILED', message: err.message, details: err.details },
    };
  }
}
