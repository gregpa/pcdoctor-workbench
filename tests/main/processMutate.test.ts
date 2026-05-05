// @vitest-environment node
//
// v2.5.30 (P3): tests for the process mutate pipeline.
//
// Mirrors serviceMutate.test.ts but simpler -- process actions don't
// have rollback rows. Locks:
//   1. dryRun=true skips actions_log writes entirely
//   2. real run inserts actions_log row (status='running'), then
//      finishActionLog with success/error
//   3. worker failure -> finishActionLog with error, ProcessMutateError thrown
//   4. envelope.success=false -> finishActionLog with error, throw with code
//   5. each public function dispatches the right worker action + params

import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  dispatchCommandMock,
  startActionLogMock,
  finishActionLogMock,
} = vi.hoisted(() => ({
  dispatchCommandMock: vi.fn(),
  startActionLogMock: vi.fn(),
  finishActionLogMock: vi.fn(),
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
}));

import {
  killProcess,
  setProcessPriority,
  setProcessAffinity,
  suspendProcess,
  resumeProcess,
  ProcessMutateError,
} from '@main/processMutate.js';

beforeEach(() => { vi.clearAllMocks(); });

function happyEnv(data: any) {
  return { id: 'abc', success: true, duration_ms: 100, data };
}
function failEnv(code: string, msg: string) {
  return { id: 'abc', success: false, duration_ms: 30, error: { code, message: msg } };
}

// ---------------------------------------------------------------------------
// killProcess
// ---------------------------------------------------------------------------

describe('killProcess', () => {
  it('dryRun=true: dispatches with dry_run flag, no DB writes', async () => {
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome', killed: [{ pid: 1234, name: 'chrome' }], count: 1,
    }));
    const r = await killProcess(1234, { dryRun: true });
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'kill-process',
      expect.objectContaining({ target: '1234', dry_run: true }),
      expect.any(Object),
    );
    expect(startActionLogMock).not.toHaveBeenCalled();
    expect(r.count).toBe(1);
  });

  it('real run: starts log, finishes success, returns action_id', async () => {
    startActionLogMock.mockReturnValueOnce(50);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome', killed: [{ pid: 1234, name: 'chrome' }], count: 1,
    }));
    const r = await killProcess('chrome');
    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_name: 'kill_process',
      params: { target: 'chrome' },
    }));
    expect(finishActionLogMock).toHaveBeenCalledWith(50, expect.objectContaining({ status: 'success' }));
    expect(r.action_id).toBe(50);
  });

  it('worker dispatch throws -> finishActionLog with error + ProcessMutateError', async () => {
    startActionLogMock.mockReturnValueOnce(51);
    const wErr: any = new Error('UAC denied');
    wErr.code = 'E_UAC_DENIED';
    Object.setPrototypeOf(wErr, (await import('@main/elevatedWorker.js')).ElevatedWorkerError.prototype);
    dispatchCommandMock.mockRejectedValueOnce(wErr);
    const err = await killProcess(1234).catch((e) => e);
    expect(err).toBeInstanceOf(ProcessMutateError);
    expect((err as ProcessMutateError).code).toBe('E_UAC_DENIED');
    expect(finishActionLogMock).toHaveBeenCalledWith(51, expect.objectContaining({ status: 'error' }));
  });

  it('envelope.success=false -> finishActionLog with error, throws', async () => {
    startActionLogMock.mockReturnValueOnce(52);
    dispatchCommandMock.mockResolvedValueOnce(failEnv('E_PROC_NOT_FOUND', 'No process with pid=9999'));
    const err = await killProcess(9999).catch((e) => e);
    expect((err as ProcessMutateError).code).toBe('E_PROC_NOT_FOUND');
    expect(finishActionLogMock).toHaveBeenCalledWith(52, expect.objectContaining({ status: 'error' }));
  });
});

// ---------------------------------------------------------------------------
// setProcessPriority / setProcessAffinity
// ---------------------------------------------------------------------------

describe('setProcessPriority', () => {
  it('dispatches set-process-priority with target+class params', async () => {
    startActionLogMock.mockReturnValueOnce(60);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome',
      before: { priority: 'Normal' }, after: { priority: 'High' },
    }));
    await setProcessPriority(1234, 'High');
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'set-process-priority',
      expect.objectContaining({ target: 1234, class: 'High' }),
      expect.any(Object),
    );
    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_name: 'set_process_priority',
      action_label: expect.stringContaining('1234 -> High'),
    }));
  });
});

describe('setProcessAffinity', () => {
  it('dispatches set-process-affinity with target+mask, hex label', async () => {
    startActionLogMock.mockReturnValueOnce(61);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome',
      before: { affinity_mask: 0xFF }, after: { affinity_mask: 0x0F },
    }));
    await setProcessAffinity(1234, 0x0F);
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'set-process-affinity',
      expect.objectContaining({ target: 1234, mask: 15 }),
      expect.any(Object),
    );
    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_label: expect.stringContaining('0xf'),
    }));
  });
});

// ---------------------------------------------------------------------------
// suspendProcess / resumeProcess
// ---------------------------------------------------------------------------

describe('suspendProcess', () => {
  it('dispatches suspend-process with target=pid', async () => {
    startActionLogMock.mockReturnValueOnce(62);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome',
      before: { status: 'Running' }, after: { status: 'Suspended' },
    }));
    await suspendProcess(1234);
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'suspend-process',
      expect.objectContaining({ target: 1234 }),
      expect.any(Object),
    );
    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_name: 'suspend_process',
    }));
  });

  it('worker error E_NT_FAILED bubbles up', async () => {
    startActionLogMock.mockReturnValueOnce(63);
    dispatchCommandMock.mockResolvedValueOnce(failEnv('E_NT_FAILED', 'NtSuspendProcess returned NTSTATUS=0xC0000022'));
    const err = await suspendProcess(1234).catch((e) => e);
    expect((err as ProcessMutateError).code).toBe('E_NT_FAILED');
  });
});

describe('resumeProcess', () => {
  it('dispatches resume-process with target=pid', async () => {
    startActionLogMock.mockReturnValueOnce(64);
    dispatchCommandMock.mockResolvedValueOnce(happyEnv({
      pid: 1234, name: 'chrome',
      before: { status: 'Suspended' }, after: { status: 'Running' },
    }));
    await resumeProcess(1234);
    expect(dispatchCommandMock).toHaveBeenCalledWith(
      'resume-process',
      expect.objectContaining({ target: 1234 }),
      expect.any(Object),
    );
    expect(startActionLogMock).toHaveBeenCalledWith(expect.objectContaining({
      action_name: 'resume_process',
    }));
  });
});
