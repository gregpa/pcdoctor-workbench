/**
 * v2.5.30: Service mutation pipeline.
 *
 * Glues:
 *   1. The elevated worker (src/main/elevatedWorker.ts) -- runs the
 *      action under admin
 *   2. The actions_log + rollbacks tables in workbench.db -- persists
 *      the change so the user can undo it later
 *
 * Three public entry points, one per service mutation, plus an undo path.
 * Each follows the same pattern:
 *
 *   for !dryRun:
 *     dispatch action via worker
 *     on success:
 *       insert actions_log row (status='success', params_json captures
 *         {service, before, after, method})
 *       insert rollbacks row (label, action_id, expires_at = now + 7d)
 *       update actions_log.rollback_id = rollback.id
 *       return { ...workerData, action_id, rollback_id }
 *     on failure:
 *       insert actions_log row (status='error', error_message)
 *       throw with the worker's error code/message
 *   for dryRun:
 *     dispatch with -DryRun flag, return result; skip DB writes
 */

import {
  dispatchCommand,
  ElevatedWorkerError,
  type WorkerAction,
  type WorkerResultEnvelope,
} from './elevatedWorker.js';
import {
  startActionLog,
  finishActionLog,
  createRollbackRow,
  updateActionLogRollbackId,
  getActionLogById,
  markActionReverted,
  getRollback,
  markRollbackReverted,
} from './dataStore.js';
import type { ActionName } from '@shared/types.js';

type ServiceActionName = Extract<ActionName, 'set_service_startup' | 'stop_service' | 'start_service'>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServiceStartupType =
  | 'Automatic'
  | 'AutomaticDelayedStart'
  | 'Manual'
  | 'Disabled';

export interface ServiceMutateBeforeAfter {
  status: string;
  start_type?: string;
}

export interface ServiceMutateResult {
  service: string;
  before: ServiceMutateBeforeAfter;
  after: ServiceMutateBeforeAfter;
  method?: string;
  duration_ms: number;
  dry_run: boolean;
  /** Present only on a real (non-DryRun) successful mutation. */
  action_id?: number;
  /** Present only on a real (non-DryRun) successful mutation. */
  rollback_id?: number;
  /** Present when the script reported it was already in the requested state. */
  noop?: boolean;
  /** Stop-Service: dependents that were running and got force-stopped. */
  dependents_stopped?: string[];
}

export class ServiceMutateError extends Error {
  code: string;
  details: Record<string, unknown> | undefined;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = 'ServiceMutateError';
  }
}

/** 7 day undo TTL (D3 default). */
const UNDO_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface MutateOpts {
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunMutateArgs {
  action: WorkerAction;
  actionLabel: string;
  actionLogName: ServiceActionName;
  params: Record<string, unknown>;
  /** Builds the human-readable rollbacks.label from worker result data. */
  buildRollbackLabel: (data: Record<string, unknown>) => string;
}

async function runMutate(args: RunMutateArgs, opts: MutateOpts = {}): Promise<ServiceMutateResult> {
  const dryRun = !!opts.dryRun;
  const workerParams = { ...args.params, ...(dryRun ? { dry_run: true } : {}) };

  // For dry-run we skip DB writes entirely.
  if (dryRun) {
    let env: WorkerResultEnvelope<Record<string, unknown>>;
    try {
      env = await dispatchCommand(args.action, workerParams, { timeoutMs: 30_000 });
    } catch (e: unknown) {
      const code = e instanceof ElevatedWorkerError ? e.code : 'E_WORKER_FAILURE';
      const msg = e instanceof Error ? e.message : 'Worker dispatch failed';
      throw new ServiceMutateError(code, msg);
    }
    if (!env.success) {
      throw new ServiceMutateError(
        env.error?.code ?? 'E_ACTION_FAILED',
        env.error?.message ?? 'Action failed',
      );
    }
    return env.data as unknown as ServiceMutateResult;
  }

  // Real-run path: open a pending log row, dispatch, finish the row, link a
  // rollback. We open the row BEFORE dispatch so even a worker spawn failure
  // gets recorded.
  const actionLogId = startActionLog({
    action_name: args.actionLogName,
    action_label: args.actionLabel,
    status: 'running',
    triggered_by: 'user',
    params: args.params,
  });

  let env: WorkerResultEnvelope<Record<string, unknown>>;
  const t0 = Date.now();
  try {
    env = await dispatchCommand(args.action, workerParams, { timeoutMs: 60_000 });
  } catch (e: unknown) {
    const code = e instanceof ElevatedWorkerError ? e.code : 'E_WORKER_FAILURE';
    const msg = e instanceof Error ? e.message : 'Worker dispatch failed';
    finishActionLog(actionLogId, { status: 'error', duration_ms: Date.now() - t0, error_message: `${code}: ${msg}` });
    throw new ServiceMutateError(code, msg);
  }

  if (!env.success) {
    finishActionLog(actionLogId, {
      status: 'error',
      duration_ms: env.duration_ms ?? Date.now() - t0,
      error_message: `${env.error?.code ?? 'E_ACTION_FAILED'}: ${env.error?.message ?? ''}`,
    });
    throw new ServiceMutateError(
      env.error?.code ?? 'E_ACTION_FAILED',
      env.error?.message ?? 'Action failed',
    );
  }

  // Worker succeeded. Finish the log row + insert rollback.
  finishActionLog(actionLogId, {
    status: 'success',
    duration_ms: env.duration_ms,
    result: env.data,
  });

  const rollbackId = createRollbackRow({
    label: args.buildRollbackLabel(env.data as Record<string, unknown>),
    action_id: actionLogId,
    expires_at: Date.now() + UNDO_TTL_MS,
  });
  updateActionLogRollbackId(actionLogId, rollbackId);

  const data = env.data as unknown as ServiceMutateResult;
  return { ...data, action_id: actionLogId, rollback_id: rollbackId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function setServiceStartup(
  service: string,
  startupType: ServiceStartupType,
  opts: MutateOpts = {},
): Promise<ServiceMutateResult> {
  return runMutate({
    action: 'set-service-startup',
    actionLogName: 'set_service_startup',
    actionLabel: `Set startup type: ${service} -> ${startupType}`,
    params: { service, startup_type: startupType },
    buildRollbackLabel: (data) => {
      const before = (data.before as ServiceMutateBeforeAfter | undefined)?.start_type ?? '?';
      const after = (data.after as ServiceMutateBeforeAfter | undefined)?.start_type ?? '?';
      return `Service ${service}: startup ${before} -> ${after}`;
    },
  }, opts);
}

export async function stopService(service: string, opts: MutateOpts = {}): Promise<ServiceMutateResult> {
  return runMutate({
    action: 'stop-service',
    actionLogName: 'stop_service',
    actionLabel: `Stop service: ${service}`,
    params: { service },
    buildRollbackLabel: () => `Service ${service}: stopped`,
  }, opts);
}

export async function startService(service: string, opts: MutateOpts = {}): Promise<ServiceMutateResult> {
  return runMutate({
    action: 'start-service',
    actionLogName: 'start_service',
    actionLabel: `Start service: ${service}`,
    params: { service },
    buildRollbackLabel: () => `Service ${service}: started`,
  }, opts);
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------

export async function undoServiceAction(actionLogId: number): Promise<ServiceMutateResult> {
  const log = getActionLogById(actionLogId);
  if (!log) throw new ServiceMutateError('E_ACTION_NOT_FOUND', `Action log id ${actionLogId} not found`);
  if (log.reverted_at !== null) {
    throw new ServiceMutateError('E_ALREADY_REVERTED', `Action ${actionLogId} was already reverted at ${new Date(log.reverted_at).toISOString()}`);
  }
  if (log.status !== 'success') {
    throw new ServiceMutateError('E_NOT_UNDOABLE', `Action ${actionLogId} did not succeed; nothing to undo`);
  }
  if (log.rollback_id === null) {
    throw new ServiceMutateError('E_NO_ROLLBACK', `Action ${actionLogId} has no associated rollback record`);
  }
  const rollback = getRollback(log.rollback_id);
  if (!rollback) throw new ServiceMutateError('E_ROLLBACK_NOT_FOUND', `Rollback ${log.rollback_id} missing`);
  if (rollback.expires_at <= Date.now()) {
    throw new ServiceMutateError('E_ROLLBACK_EXPIRED', `Rollback expired at ${new Date(rollback.expires_at).toISOString()}`);
  }
  if (rollback.reverted_at !== null) {
    throw new ServiceMutateError('E_ALREADY_REVERTED', `Rollback ${log.rollback_id} was already reverted`);
  }

  const params = log.params_json ? (JSON.parse(log.params_json) as Record<string, unknown>) : {};
  const result = log.result_json ? (JSON.parse(log.result_json) as Record<string, unknown>) : {};
  const service = String(params.service ?? '');
  if (!service) throw new ServiceMutateError('E_BAD_LOG_DATA', `Action ${actionLogId} has no service param`);

  // Reverse the action by inspecting log.action_name.
  const before = result.before as ServiceMutateBeforeAfter | undefined;
  if (!before) throw new ServiceMutateError('E_BAD_LOG_DATA', `Action ${actionLogId} has no before-state recorded`);

  let reversed: ServiceMutateResult;
  switch (log.action_name) {
    case 'set_service_startup': {
      const priorStartType = before.start_type as ServiceStartupType | undefined;
      if (!priorStartType) throw new ServiceMutateError('E_BAD_LOG_DATA', 'No prior start_type to restore');
      reversed = await setServiceStartup(service, priorStartType);
      break;
    }
    case 'stop_service': {
      // Reverse of stop is start. before.status was 'Running' for any real
      // (non-noop) row; if the prior status wasn't Running we shouldn't have
      // logged the action. Belt-and-braces: still reverse to start.
      reversed = await startService(service);
      break;
    }
    case 'start_service': {
      reversed = await stopService(service);
      break;
    }
    default:
      throw new ServiceMutateError('E_UNKNOWN_ACTION', `Cannot undo action_name=${log.action_name}`);
  }

  // Mark the original log + rollback as reverted (the reverse action is its
  // OWN log/rollback row, separately undoable -- chaining undos is fine).
  markActionReverted(actionLogId);
  markRollbackReverted(log.rollback_id);

  return reversed;
}
