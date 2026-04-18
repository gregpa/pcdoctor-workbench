import { ACTIONS } from '@shared/actions.js';
import type { ActionName, ActionResult } from '@shared/types.js';
import { runPowerShellScript, PCDoctorScriptError } from './scriptRunner.js';
import { startActionLog, finishActionLog } from './dataStore.js';
import { prepareRollback } from './rollbackManager.js';
import { notify } from './notifier.js';

export interface RunActionInput {
  name: ActionName;
  params?: Record<string, string | number>;
  triggered_by?: 'user' | 'scheduled' | 'telegram' | 'alert';
  dry_run?: boolean;
}

export async function runAction(input: RunActionInput): Promise<ActionResult> {
  const def = ACTIONS[input.name];
  if (!def) {
    return {
      action: input.name,
      success: false,
      duration_ms: 0,
      error: { code: 'E_ACTION_UNKNOWN', message: `Unknown action: ${input.name}` },
    };
  }

  const logId = startActionLog({
    action_name: input.name,
    action_label: def.label,
    status: 'running',
    triggered_by: input.triggered_by ?? 'user',
    params: input.params,
  });

  let rollbackId: number | null = null;
  if (def.rollback_tier === 'A' || def.rollback_tier === 'B') {
    try {
      rollbackId = await prepareRollback(def, logId);
      if (rollbackId !== null) {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database: new (p: string) => import('better-sqlite3').Database = require('better-sqlite3');
        const { WORKBENCH_DB_PATH } = require('./constants.js');
        const conn = new Database(WORKBENCH_DB_PATH);
        try {
          conn.prepare(`UPDATE actions_log SET rollback_id = ? WHERE id = ?`).run(rollbackId, logId);
        } finally {
          conn.close();
        }
      }
    } catch (e) {
      // Proceeding without rollback — action may still succeed, but revert won't be available.
    }
  }

  const scriptArgs = ['-JsonOutput'];
  if (input.dry_run) {
    scriptArgs.push('-DryRun');
  }
  if (input.params) {
    for (const [k, v] of Object.entries(input.params)) {
      scriptArgs.push(`-${k.charAt(0).toUpperCase() + k.slice(1)}`, String(v));
    }
  }

  // Special case: install_security_updates uses same script as install_windows_updates but with -SecurityOnly flag
  if (input.name === 'install_security_updates') {
    scriptArgs.push('-SecurityOnly');
  }

  const start = Date.now();
  try {
    const result = await runPowerShellScript<Record<string, unknown>>(def.ps_script, scriptArgs);
    const duration = Date.now() - start;
    finishActionLog(logId, { status: 'success', duration_ms: duration, result });
    // Fire success notification (user-triggered only; telegram/scheduled get silent logs)
    if ((input.triggered_by ?? 'user') === 'user') {
      notify({
        severity: 'info',
        title: `✓ ${def.label}`,
        body: (result as any)?.message ?? 'Completed',
        eventKey: 'action_succeeded',
      }).catch(() => {});
    }
    return { action: input.name, success: true, duration_ms: duration, result };
  } catch (e) {
    const duration = Date.now() - start;
    const err = e as PCDoctorScriptError;
    finishActionLog(logId, {
      status: 'error', duration_ms: duration, error_message: err.message,
    });
    notify({
      severity: 'warning',
      title: `✗ ${def.label} failed`,
      body: err.message ?? 'Action failed',
      eventKey: 'action_failed',
    }).catch(() => {});
    return {
      action: input.name, success: false, duration_ms: duration,
      error: { code: err.code ?? 'E_ACTION_FAILED', message: err.message, details: err.details },
    };
  }
}
