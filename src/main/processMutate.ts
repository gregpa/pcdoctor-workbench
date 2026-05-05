/**
 * v2.5.30: Process mutation pipeline.
 *
 * Sister of serviceMutate.ts but simpler: process actions are NOT
 * undoable, so there's no rollback row -- just an actions_log entry per
 * mutation. Five public functions: kill, setPriority, setAffinity,
 * suspend, resume. Each routes through the same elevated worker as the
 * service mutates (UAC once per session).
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
} from './dataStore.js';
import type { ActionName, ProcessPriorityClass } from '@shared/types.js';

type ProcessActionName = Extract<ActionName,
  | 'kill_process'
  | 'set_process_priority'
  | 'set_process_affinity'
  | 'suspend_process'
  | 'resume_process'
>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessMutateResult {
  pid: number;
  name?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  duration_ms: number;
  dry_run: boolean;
  noop?: boolean;
  /** Present for kill: number of processes terminated. */
  count?: number;
  /** Present for kill: array of {pid, name}. */
  killed?: Array<{ pid: number; name: string }>;
  action_id?: number;
}

export class ProcessMutateError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProcessMutateError';
  }
}

interface MutateOpts {
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helper
// ---------------------------------------------------------------------------

interface RunMutateArgs {
  action: WorkerAction;
  actionLabel: string;
  actionLogName: ProcessActionName;
  params: Record<string, unknown>;
}

async function runMutate(args: RunMutateArgs, opts: MutateOpts = {}): Promise<ProcessMutateResult> {
  const dryRun = !!opts.dryRun;
  const workerParams = { ...args.params, ...(dryRun ? { dry_run: true } : {}) };

  if (dryRun) {
    let env: WorkerResultEnvelope<Record<string, unknown>>;
    try {
      env = await dispatchCommand(args.action, workerParams, { timeoutMs: 30_000 });
    } catch (e: unknown) {
      const code = e instanceof ElevatedWorkerError ? e.code : 'E_WORKER_FAILURE';
      const msg = e instanceof Error ? e.message : 'Worker dispatch failed';
      throw new ProcessMutateError(code, msg);
    }
    if (!env.success) {
      throw new ProcessMutateError(env.error?.code ?? 'E_ACTION_FAILED', env.error?.message ?? 'Action failed');
    }
    return env.data as unknown as ProcessMutateResult;
  }

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
    throw new ProcessMutateError(code, msg);
  }

  if (!env.success) {
    finishActionLog(actionLogId, {
      status: 'error',
      duration_ms: env.duration_ms ?? Date.now() - t0,
      error_message: `${env.error?.code ?? 'E_ACTION_FAILED'}: ${env.error?.message ?? ''}`,
    });
    throw new ProcessMutateError(env.error?.code ?? 'E_ACTION_FAILED', env.error?.message ?? 'Action failed');
  }

  finishActionLog(actionLogId, {
    status: 'success',
    duration_ms: env.duration_ms,
    result: env.data,
  });

  const data = env.data as unknown as ProcessMutateResult;
  return { ...data, action_id: actionLogId };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function killProcess(target: number | string, opts: MutateOpts = {}): Promise<ProcessMutateResult> {
  return runMutate({
    action: 'kill-process',
    actionLogName: 'kill_process',
    actionLabel: `Kill process: ${target}`,
    params: { target: String(target) },
  }, opts);
}

export async function setProcessPriority(
  pid: number,
  priorityClass: ProcessPriorityClass,
  opts: MutateOpts = {},
): Promise<ProcessMutateResult> {
  return runMutate({
    action: 'set-process-priority',
    actionLogName: 'set_process_priority',
    actionLabel: `Set priority: pid=${pid} -> ${priorityClass}`,
    params: { target: pid, class: priorityClass },
  }, opts);
}

export async function setProcessAffinity(
  pid: number,
  mask: number,
  opts: MutateOpts = {},
): Promise<ProcessMutateResult> {
  return runMutate({
    action: 'set-process-affinity',
    actionLogName: 'set_process_affinity',
    actionLabel: `Set CPU affinity: pid=${pid} -> 0x${mask.toString(16)}`,
    params: { target: pid, mask },
  }, opts);
}

export async function suspendProcess(pid: number, opts: MutateOpts = {}): Promise<ProcessMutateResult> {
  return runMutate({
    action: 'suspend-process',
    actionLogName: 'suspend_process',
    actionLabel: `Suspend process: pid=${pid}`,
    params: { target: pid },
  }, opts);
}

export async function resumeProcess(pid: number, opts: MutateOpts = {}): Promise<ProcessMutateResult> {
  return runMutate({
    action: 'resume-process',
    actionLogName: 'resume_process',
    actionLabel: `Resume process: pid=${pid}`,
    params: { target: pid },
  }, opts);
}
