import { ACTIONS } from '@shared/actions.js';
import type { ActionName, ActionResult } from '@shared/types.js';
import { runPowerShellScript, runElevatedPowerShellScript, PCDoctorScriptError } from './scriptRunner.js';
import { startActionLog, finishActionLog, insertToolResult, updateActionLogRollbackId } from './dataStore.js';
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
        // Use the dataStore singleton connection. Opening a second connection
        // to a WAL-mode DB from the same process can race with the primary
        // connection's write transaction and surface as SQLITE_READONLY.
        updateActionLogRollbackId(logId, rollbackId);
      }
    } catch (e) {
      // Proceeding without rollback - action may still succeed, but revert won't be available.
      console.warn(`actionRunner: prepareRollback failed for ${input.name}:`, e);
    }
  }

  const scriptArgs = ['-JsonOutput'];
  if (input.dry_run) {
    scriptArgs.push('-DryRun');
  }
  {
    // Param handling: reviewer P0 - previous code type-checked values
    // declared in params_schema but silently forwarded ANY other param to
    // PowerShell. A caller could smuggle undeclared flags (e.g. the renderer
    // calling update_hosts_stevenblack with -SourceUrl, which has no
    // params_schema but whose script accepts -SourceUrl, redirecting the
    // hosts merge to an attacker-controlled URL). Now:
    //   - unknown key -> E_UNKNOWN_PARAM
    //   - missing required -> E_MISSING_PARAM
    //   - key charset enforced to [a-z_][a-z0-9_]* (defense-in-depth
    //     against concatenation into the elevated -Command string)
    //   - value type-checked per schema
    const schema = def.params_schema ?? {};
    const input_params = input.params ?? {};

    // 1) Unknown-key rejection. This is the bypass fix.
    for (const k of Object.keys(input_params)) {
      if (!(k in schema)) {
        finishActionLog(logId, { status: 'error', duration_ms: 0, error_message: `Unknown parameter '${k}' for action '${input.name}'` });
        return {
          action: input.name, success: false, duration_ms: 0,
          error: { code: 'E_UNKNOWN_PARAM', message: `Unknown parameter '${k}' for action '${input.name}'` },
        };
      }
      if (!/^[a-z_][a-z0-9_]*$/i.test(k)) {
        finishActionLog(logId, { status: 'error', duration_ms: 0, error_message: `Invalid parameter name '${k}'` });
        return {
          action: input.name, success: false, duration_ms: 0,
          error: { code: 'E_INVALID_PARAM_NAME', message: `Bad param name: ${k}` },
        };
      }
    }

    // 2) Required-param enforcement + value validation.
    for (const [name, spec] of Object.entries(schema)) {
      const value = input_params[name];
      const missing = value === undefined || value === null || value === '';
      if (spec.required && missing) {
        finishActionLog(logId, { status: 'error', duration_ms: 0, error_message: `Missing required parameter '${name}'` });
        return {
          action: input.name, success: false, duration_ms: 0,
          error: { code: 'E_MISSING_PARAM', message: `Missing required parameter '${name}'` },
        };
      }
      if (missing) continue;
      const str = String(value);
      if (spec.type === 'number' && !/^-?\d+(\.\d+)?$/.test(str)) {
        finishActionLog(logId, { status: 'error', duration_ms: 0, error_message: `Invalid param '${name}': expected number, got '${str}'` });
        return {
          action: input.name, success: false, duration_ms: 0,
          error: { code: 'E_INVALID_PARAM', message: `Invalid param '${name}': expected number` },
        };
      }
      scriptArgs.push(`-${name.charAt(0).toUpperCase() + name.slice(1)}`, str);
    }
  }

  // Special case: install_security_updates uses same script as install_windows_updates but with -SecurityOnly flag
  if (input.name === 'install_security_updates') {
    scriptArgs.push('-SecurityOnly');
  }

  const start = Date.now();
  try {
    // Actions flagged needs_admin are spawned via Start-Process -Verb RunAs
    // (triggers a UAC prompt per invocation). Keeps the Workbench itself
    // non-elevated while still allowing privileged actions.
    const runner = def.needs_admin ? runElevatedPowerShellScript : runPowerShellScript;
    const result = await runner<Record<string, unknown>>(def.ps_script, scriptArgs);
    const duration = Date.now() - start;
    finishActionLog(logId, { status: 'success', duration_ms: duration, result });
    // Capture tool-import results into tool_results history
    if (input.name === 'import_hwinfo_csv' || input.name === 'import_occt_csv') {
      try {
        const r = result as any;
        insertToolResult({
          tool_id: input.name.replace('import_', '').replace('_csv', ''),
          csv_path: r?.csv_path,
          samples: r?.samples,
          findings: r?.findings,
          summary: r?.message,
        });
      } catch {}
    }
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
