// @vitest-environment node
//
// v2.5.30: tests for the service mutate pipeline.
//
// Locks the orchestration contract:
//   1. dryRun=true skips DB writes entirely (just dispatches with dry_run flag)
//   2. real run inserts actions_log row (status=running), then finishes it
//      on dispatch result, then inserts rollbacks row, then links them
//   3. worker failure -> finishActionLog with error, ServiceMutateError thrown
//   4. envelope.success=false -> finishActionLog with error, throw with code
//   5. undoServiceAction guards: not-found / already-reverted / expired
//   6. undoServiceAction success: dispatches reverse action, marks both
//      original log + rollback as reverted
//
// What it does NOT test: the worker itself (covered by elevatedWorker.test.ts),
// the PS scripts themselves (covered by smoke tests + the PS5.1 syntax gate).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (declared via vi.hoisted so vi.mock factories see them) ─────────
const {
  dispatchCommandMock,
  startActionLogMock,
  finishActionLogMock,
  createRollbackRowMock,
  updateActionLogRollbackIdMock,
  getActionLogByIdMock,
  markActionRevertedMock,
  getRollbackMock,
  markRollbackRevertedMock,
} = vi.hoisted(() => ({
  dispatchCommandMock: vi.fn(),
  startActionLogMock: vi.fn(),
  finishActionLogMock: vi.fn(),
  createRollbackRowMock: vi.fn(),
  updateActionLogRollbackIdMock: vi.fn(),
  getActionLogByIdMock: vi.fn(),
  markActionRevertedMock: vi.fn(),
  getRollbackMock: vi.fn(),
  markRollbackRevertedMock: vi.fn(),
}));

vi.mock('@main/elevatedWorker.js', () => ({
  dispatchCommand: dispatchCommandMock,
  ElevatedWorkerError: class extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
      this.name = 'ElevatedWorkerError';
    }
  },
  WORKER_ACTIONS: [
    'set-service-startup', 'stop-service', 'start-service', 'restart-service',
    'kill-process', 'set-process-priority', 'set-process-affinity',
    'suspend-process', 'resume-process',
  ],
}));

vi.mock('@main/dataStore.js', () => ({
  startActionLog: startActionLogMock,
  finishActionLog: finishActionLogMock,
  createRollbackRow: createRollbackRowMock,
  updateActionLogRollbackId: updateActionLogRollbackIdMock,
  getActionLogById: getActionLogByIdMock,
  markActionReverted: markActionRevertedMock,
  getRollback: getRollbackMock,
  markRollbackReverted: markRollbackRevertedMock,
}));

import {
  setServiceStartup,
  stopService,
  startService,
  undoServiceAction,
  ServiceMutateError,
} from '@main/serviceMutate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function happyEnv(action: string, before: any, after: any) {
  return {
    id: 'abc',
    success: true,
    duration_ms: 250,
    data: { service: 'Spooler', before, after, method: 'Set-Service', dry_run: false },
  };
}

function failEnv(code: string, msg: string) {
  return {
    id: 'abc',
    success: false,
    duration_ms: 30,
    error: { code, message: msg },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// setServiceStartup
// ---------------------------------------------------------------------------

describe('setServiceStartup', () => {
  it('dryRun=true: dispatches with dry_run flag, no DB writes', async () => {
    dispatchCommandMock.mockResolvedValueOnce({
      id: 'abc', success: true, duration_ms: 5,
      data: {
        service: 'Spooler',
        before: { status: 'Running', start_type: 'Automatic' },
        after: { status: 'Running', start_type: 'Disabled' },
        method: 'dry-run', dry_run: true,
      },
    });
    const r = await setServiceStartup('Spooler', 'Disabled', { dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.after.start_type).toBe('Disabled');
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'set-service-startup',
      expect.objectContaining({ service: 'Spooler', startup_type: 'Disabled', dry_run: true }),
      expect.any(Object),
    );
    expect(startActionLogMock).not.toHaveBeenCalled();
    expect(createRollbackRowMock).not.toHaveBeenCalled();
  });

  it('real run happy path: starts log, finishes success, creates rollback, links them, returns ids', async () => {
    startActionLogMock.mockReturnValueOnce(42);
    createRollbackRowMock.mockReturnValueOnce(100);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv(
      'set-service-startup',
      { status: 'Running', start_type: 'Automatic' },
      { status: 'Running', start_type: 'Disabled' },
    ));

    const r = await setServiceStartup('Spooler', 'Disabled');

    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_name: 'set_service_startup',
      status: 'running',
      params: { service: 'Spooler', startup_type: 'Disabled' },
    }));
    expect(finishActionLogMock).toHaveBeenCalledWith(42, expect.objectContaining({
      status: 'success',
      duration_ms: 250,
    }));
    expect(createRollbackRowMock).toHaveBeenCalledWith(expect.objectContaining({
      action_id: 42,
      label: expect.stringContaining('Automatic -> Disabled'),
    }));
    expect(updateActionLogRollbackIdMock).toHaveBeenCalledWith(42, 100);
    expect(r.action_id).toBe(42);
    expect(r.rollback_id).toBe(100);
  });

  it('worker dispatch throws -> finishActionLog with error + ServiceMutateError', async () => {
    startActionLogMock.mockReturnValueOnce(43);
    const wErr: any = new Error('UAC denied');
    wErr.code = 'E_UAC_DENIED';
    wErr.name = 'ElevatedWorkerError';
    Object.setPrototypeOf(wErr, (await import('@main/elevatedWorker.js')).ElevatedWorkerError.prototype);
    dispatchCommandMock.mockRejectedValueOnce(wErr);

    const err = await setServiceStartup('Spooler', 'Disabled').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceMutateError);
    expect((err as ServiceMutateError).code).toBe('E_UAC_DENIED');
    expect(finishActionLogMock).toHaveBeenCalledWith(43, expect.objectContaining({
      status: 'error',
      error_message: expect.stringContaining('E_UAC_DENIED'),
    }));
    expect(createRollbackRowMock).not.toHaveBeenCalled();
  });

  it('envelope.success=false -> finishActionLog with error, throws with worker error code', async () => {
    startActionLogMock.mockReturnValueOnce(44);
    dispatchCommandMock.mockResolvedValueOnce(failEnv('E_SVC_NOT_FOUND', 'Service does not exist'));

    const err = await setServiceStartup('Nonexistent', 'Disabled').catch((e) => e);
    expect(err).toBeInstanceOf(ServiceMutateError);
    expect((err as ServiceMutateError).code).toBe('E_SVC_NOT_FOUND');
    expect(finishActionLogMock).toHaveBeenCalledWith(44, expect.objectContaining({
      status: 'error',
    }));
    expect(createRollbackRowMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// stopService / startService
// ---------------------------------------------------------------------------

describe('stopService', () => {
  it('happy path: real run logs + creates rollback', async () => {
    startActionLogMock.mockReturnValueOnce(50);
    createRollbackRowMock.mockReturnValueOnce(200);
    dispatchCommandMock.mockResolvedValueOnce({
      id: 'a', success: true, duration_ms: 600,
      data: { service: 'Spooler', before: { status: 'Running' }, after: { status: 'Stopped' } },
    });

    const r = await stopService('Spooler');

    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({ action_name: 'stop_service' }));
    expect(r.action_id).toBe(50);
    expect(r.rollback_id).toBe(200);
    expect(createRollbackRowMock).toHaveBeenCalledWith(expect.objectContaining({
      label: expect.stringContaining('Spooler: stopped'),
    }));
  });
});

describe('startService', () => {
  it('happy path: real run logs + creates rollback', async () => {
    startActionLogMock.mockReturnValueOnce(51);
    createRollbackRowMock.mockReturnValueOnce(201);
    dispatchCommandMock.mockResolvedValueOnce({
      id: 'a', success: true, duration_ms: 700,
      data: { service: 'Spooler', before: { status: 'Stopped' }, after: { status: 'Running' } },
    });

    const r = await startService('Spooler');

    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({ action_name: 'start_service' }));
    expect(r.action_id).toBe(51);
    expect(r.rollback_id).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// undoServiceAction
// ---------------------------------------------------------------------------

describe('undoServiceAction', () => {
  function makeLog(over: Partial<any> = {}) {
    return {
      id: 42,
      ts: Date.now() - 1000,
      action_name: 'set_service_startup',
      action_label: 'Set startup type: Spooler -> Disabled',
      status: 'success',
      duration_ms: 250,
      result_json: JSON.stringify({
        service: 'Spooler',
        before: { status: 'Running', start_type: 'Automatic' },
        after: { status: 'Running', start_type: 'Disabled' },
        method: 'Set-Service', dry_run: false,
      }),
      error_message: null,
      rollback_id: 100,
      reverted_at: null,
      triggered_by: 'user',
      params_json: JSON.stringify({ service: 'Spooler', startup_type: 'Disabled' }),
      ...over,
    };
  }

  function makeRollback(over: Partial<any> = {}) {
    return {
      id: 100,
      ts: Date.now() - 1000,
      label: 'Service Spooler: startup Automatic -> Disabled',
      windows_rp_seq: null,
      snapshot_path: null,
      action_id: 42,
      expires_at: Date.now() + 7 * 24 * 60 * 60 * 1000,
      reverted_at: null,
      ...over,
    };
  }

  it('throws E_ACTION_NOT_FOUND when action log id missing', async () => {
    getActionLogByIdMock.mockReturnValueOnce(null);
    const err = await undoServiceAction(999).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceMutateError);
    expect((err as ServiceMutateError).code).toBe('E_ACTION_NOT_FOUND');
  });

  it('throws E_ALREADY_REVERTED when action.reverted_at is set', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({ reverted_at: Date.now() - 100 }));
    const err = await undoServiceAction(42).catch((e) => e);
    expect((err as ServiceMutateError).code).toBe('E_ALREADY_REVERTED');
  });

  it('throws E_NOT_UNDOABLE when action.status is not success', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({ status: 'error' }));
    const err = await undoServiceAction(42).catch((e) => e);
    expect((err as ServiceMutateError).code).toBe('E_NOT_UNDOABLE');
  });

  it('throws E_NO_ROLLBACK when rollback_id is null', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({ rollback_id: null }));
    const err = await undoServiceAction(42).catch((e) => e);
    expect((err as ServiceMutateError).code).toBe('E_NO_ROLLBACK');
  });

  it('throws E_ROLLBACK_EXPIRED when rollback.expires_at <= now', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog());
    getRollbackMock.mockReturnValueOnce(makeRollback({ expires_at: Date.now() - 1000 }));
    const err = await undoServiceAction(42).catch((e) => e);
    expect((err as ServiceMutateError).code).toBe('E_ROLLBACK_EXPIRED');
  });

  it('reverses set_service_startup by dispatching with the prior start_type', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog());
    getRollbackMock.mockReturnValueOnce(makeRollback());
    // The reverse action is itself a setServiceStartup, which goes through
    // the full pipeline (startActionLog -> dispatch -> finishActionLog ->
    // createRollbackRow -> updateActionLogRollbackId).
    startActionLogMock.mockReturnValueOnce(43);
    createRollbackRowMock.mockReturnValueOnce(101);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv(
      'set-service-startup',
      { status: 'Running', start_type: 'Disabled' },
      { status: 'Running', start_type: 'Automatic' },
    ));

    const r = await undoServiceAction(42);

    // Reverse action params: should use the prior (Automatic) start_type.
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'set-service-startup',
      expect.objectContaining({ service: 'Spooler', startup_type: 'Automatic' }),
      expect.any(Object),
    );
    expect(r.action_id).toBe(43);
    expect(markActionRevertedMock).toHaveBeenCalledWith(42);
    expect(markRollbackRevertedMock).toHaveBeenCalledWith(100);
  });

  it('reverses stop_service by dispatching start-service', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({
      action_name: 'stop_service',
      result_json: JSON.stringify({
        service: 'Spooler',
        before: { status: 'Running' },
        after: { status: 'Stopped' },
      }),
      params_json: JSON.stringify({ service: 'Spooler' }),
    }));
    getRollbackMock.mockReturnValueOnce(makeRollback());
    startActionLogMock.mockReturnValueOnce(45);
    createRollbackRowMock.mockReturnValueOnce(102);
    dispatchCommandMock.mockResolvedValueOnce({
      id: 'b', success: true, duration_ms: 500,
      data: { service: 'Spooler', before: { status: 'Stopped' }, after: { status: 'Running' } },
    });

    await undoServiceAction(42);
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'start-service',
      expect.objectContaining({ service: 'Spooler' }),
      expect.any(Object),
    );
  });

  it('reverses start_service by dispatching stop-service', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({
      action_name: 'start_service',
      result_json: JSON.stringify({
        service: 'Spooler',
        before: { status: 'Stopped' },
        after: { status: 'Running' },
      }),
      params_json: JSON.stringify({ service: 'Spooler' }),
    }));
    getRollbackMock.mockReturnValueOnce(makeRollback());
    startActionLogMock.mockReturnValueOnce(46);
    createRollbackRowMock.mockReturnValueOnce(103);
    dispatchCommandMock.mockResolvedValueOnce({
      id: 'c', success: true, duration_ms: 400,
      data: { service: 'Spooler', before: { status: 'Running' }, after: { status: 'Stopped' } },
    });

    await undoServiceAction(42);
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'stop-service',
      expect.objectContaining({ service: 'Spooler' }),
      expect.any(Object),
    );
  });

  it('throws E_UNKNOWN_ACTION on unrecognized action_name', async () => {
    getActionLogByIdMock.mockReturnValueOnce(makeLog({ action_name: 'flush_dns' }));
    getRollbackMock.mockReturnValueOnce(makeRollback());
    const err = await undoServiceAction(42).catch((e) => e);
    expect((err as ServiceMutateError).code).toBe('E_UNKNOWN_ACTION');
  });
});
