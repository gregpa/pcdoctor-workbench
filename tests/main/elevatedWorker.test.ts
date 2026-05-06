// @vitest-environment node
//
// v2.5.30: tests for the batched-UAC elevated-worker dispatcher.
//
// The worker itself is a long-lived elevated PowerShell process that polls
// %LOCALAPPDATA%\PCDoctor\worker-queue\ for cmd files. These tests cover
// the TS-side dispatcher (src/main/elevatedWorker.ts) against a mocked
// filesystem; the PS worker is exercised via end-to-end smoke tests
// (out of scope for vitest because they require a real UAC prompt).
//
// What's locked here:
//   - heartbeat staleness logic (isWorkerAlive)
//   - action allowlist (dispatchCommand rejects unknown actions)
//   - happy-path dispatch (writeFile -> existsSync poll -> readFile -> parse)
//   - timeout path (no result file ever appears)
//   - parse-error path (result file exists but is malformed)
//   - cleanup (cmd + result files removed after read)
//   - worker-already-running short-circuit (no spawn when heartbeat fresh)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock fs operations the dispatcher uses ─────────────────────────────────
// We hold a virtual filesystem in memory so test cases can install fake
// heartbeat/result files at the same paths the dispatcher reads. Both the
// fakeFs Map and the spawnMock fn must be defined via vi.hoisted() so the
// vi.mock factories (which are themselves hoisted to module top) can see them.
const { fakeFs, spawnMock } = vi.hoisted(() => ({
  fakeFs: new Map<string, string>(),
  spawnMock: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: any) => fakeFs.has(String(p))),
    readFileSync: vi.fn((p: any) => {
      const v = fakeFs.get(String(p));
      if (v === undefined) throw new Error(`ENOENT (mock): ${p}`);
      return v;
    }),
    writeFileSync: vi.fn((p: any, data: any) => {
      fakeFs.set(String(p), String(data));
    }),
    rmSync: vi.fn((p: any) => { fakeFs.delete(String(p)); }),
    mkdirSync: vi.fn(() => undefined),
  };
});

vi.mock('electron-log/main.js', () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('@main/scriptRunner.js', () => ({
  resolveScriptPath: vi.fn((rel: string) => `C:\\ProgramData\\PCDoctor\\${rel.replace(/\//g, '\\')}`),
}));

vi.mock('@main/constants.js', () => ({
  PCDOCTOR_ROOT: 'C:\\ProgramData\\PCDoctor',
  resolvePwshPath: vi.fn(() => 'pwsh.exe'),
  PWSH_FALLBACK: 'powershell.exe',
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: spawnMock,
  };
});

import {
  WORKER_ACTIONS,
  ElevatedWorkerError,
  readHeartbeat,
  isWorkerAlive,
  ensureWorkerRunning,
  dispatchCommand,
  getQueueDir,
  buildLaunchCmd,
  _testing,
} from '@main/elevatedWorker.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearFs() {
  fakeFs.clear();
}

const queueDir = getQueueDir();
const heartbeatPath = `${queueDir}\\.heartbeat`;

function setHeartbeat(opts: { ageMs?: number; pid?: number; version?: string } = {}) {
  const last = Date.now() - (opts.ageMs ?? 0);
  fakeFs.set(heartbeatPath, JSON.stringify({
    pid: opts.pid ?? 1234,
    started_at: last,
    last_seen: last,
    version: opts.version ?? '2.5.37',
  }));
}

function setResult(id: string, payload: object) {
  fakeFs.set(_testing.getResultPath(id), JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('elevatedWorker > heartbeat', () => {
  beforeEach(() => { clearFs(); spawnMock.mockClear(); });

  it('readHeartbeat returns null when file missing', () => {
    expect(readHeartbeat()).toBeNull();
  });

  it('readHeartbeat returns the parsed object when file present', () => {
    setHeartbeat({ pid: 9999 });
    const hb = readHeartbeat();
    expect(hb?.pid).toBe(9999);
    expect(hb?.version).toBe('2.5.37');
  });

  it('readHeartbeat returns null on malformed JSON', () => {
    fakeFs.set(heartbeatPath, '{not valid json');
    expect(readHeartbeat()).toBeNull();
  });

  it('isWorkerAlive false when heartbeat missing', () => {
    expect(isWorkerAlive()).toBe(false);
  });

  it('isWorkerAlive true when heartbeat fresh (<30s)', () => {
    setHeartbeat({ ageMs: 5_000 });
    expect(isWorkerAlive()).toBe(true);
  });

  it('isWorkerAlive false when heartbeat stale (>30s)', () => {
    setHeartbeat({ ageMs: 60_000 });
    expect(isWorkerAlive()).toBe(false);
  });
});

describe('elevatedWorker > ensureWorkerRunning', () => {
  beforeEach(() => { clearFs(); spawnMock.mockClear(); });

  it('no-ops (no spawn) when worker is already alive', async () => {
    setHeartbeat({ ageMs: 1000 });
    await ensureWorkerRunning();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('spawns and resolves once heartbeat appears post-spawn', async () => {
    // spawnWorker checks the worker script exists before invoking spawn;
    // pretend the canonical path resolves so we exercise the heartbeat-
    // wait branch rather than the missing-script branch.
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);
    await ensureWorkerRunning();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('throws E_WORKER_NO_HEARTBEAT when heartbeat never appears within timeout', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    // We need to override the spawn timeout for this test or it would take
    // 60s. Use vi.useFakeTimers to fast-forward through the 250ms-poll loop.
    vi.useFakeTimers();
    const promise = ensureWorkerRunning().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(_testing.WORKER_SPAWN_TIMEOUT_MS + 1000);
    const err = await promise;
    vi.useRealTimers();
    expect(err).toBeInstanceOf(ElevatedWorkerError);
    expect((err as ElevatedWorkerError).code).toBe('E_WORKER_NO_HEARTBEAT');
  });

  // v2.5.33 regression: passing { detached: true } to child_process.spawn on
  // Windows breaks the UAC elevation propagation through ShellExecuteEx, so
  // the UAC prompt never appears and the worker never spawns. Empirically
  // verified against Electron production. Pin detached:false so the bug
  // can't reappear during a future "let's clean up the spawn opts" pass.
  it('spawn opts have detached:false (v2.5.33 regression)', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);
    await ensureWorkerRunning();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const lastCall = spawnMock.mock.calls[0];
    const opts = lastCall[2] as { detached?: boolean; stdio?: unknown; windowsHide?: boolean };
    // detached MUST be false (or absent). Anything else regresses v2.5.30-32.
    expect(opts.detached).not.toBe(true);
    // While we're here, pin the rest of the production options too.
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
  });
});

describe('elevatedWorker > dispatchCommand', () => {
  beforeEach(() => { clearFs(); spawnMock.mockClear(); });

  it('throws E_INVALID_ACTION before any spawn for unknown action', async () => {
    setHeartbeat({ ageMs: 1000 });
    const err = await dispatchCommand('nuke-system32' as any, {}).catch((e) => e);
    expect(err).toBeInstanceOf(ElevatedWorkerError);
    expect(err.code).toBe('E_INVALID_ACTION');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('happy path: writes cmd file, polls for result, parses and cleans up', async () => {
    setHeartbeat({ ageMs: 1000 });
    // Schedule a fake worker response after 200ms.
    setTimeout(() => {
      // Find the cmd file the dispatcher just wrote and reply.
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      expect(cmdFiles.length).toBe(1);
      const id = cmdFiles[0].match(/([a-f0-9]+)\.cmd\.json$/)?.[1];
      expect(id).toBeDefined();
      setResult(id!, {
        id,
        success: true,
        data: { before: { start_type: 'Automatic' }, after: { start_type: 'Disabled' } },
        duration_ms: 240,
      });
    }, 200);

    const result = await dispatchCommand('set-service-startup', {
      service: 'Spooler',
      startupType: 'Disabled',
    });
    expect(result.success).toBe(true);
    expect((result.data as any).after.start_type).toBe('Disabled');

    // Both cmd and result files should be cleaned up.
    const remainingQueueFiles = Array.from(fakeFs.keys()).filter(
      (k) => k.endsWith('.cmd.json') || k.endsWith('.result.json'),
    );
    expect(remainingQueueFiles).toEqual([]);
  });

  it('returns the success=false envelope when the worker reports an error', async () => {
    setHeartbeat({ ageMs: 1000 });
    setTimeout(() => {
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      const id = cmdFiles[0].match(/([a-f0-9]+)\.cmd\.json$/)?.[1];
      setResult(id!, {
        id,
        success: false,
        error: { code: 'E_SVC_NOT_FOUND', message: 'Service does not exist' },
        duration_ms: 30,
      });
    }, 200);

    const result = await dispatchCommand('set-service-startup', {
      service: 'Nonexistent',
      startupType: 'Disabled',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SVC_NOT_FOUND');
  });

  it('throws E_CMD_TIMEOUT and cleans up the cmd file when no result appears', async () => {
    setHeartbeat({ ageMs: 1000 });
    const err = await dispatchCommand('stop-service', { serviceName: 'Spooler' }, { timeoutMs: 300 })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ElevatedWorkerError);
    expect(err.code).toBe('E_CMD_TIMEOUT');
    // cmd file should have been cleaned up after timeout.
    const lingering = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
    expect(lingering).toEqual([]);
  });

  it('throws E_BAD_RESULT when the result file is malformed JSON', async () => {
    setHeartbeat({ ageMs: 1000 });
    setTimeout(() => {
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      const id = cmdFiles[0].match(/([a-f0-9]+)\.cmd\.json$/)?.[1];
      fakeFs.set(_testing.getResultPath(id!), '{ not valid');
    }, 200);

    const err = await dispatchCommand('start-service', { serviceName: 'Spooler' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ElevatedWorkerError);
    expect(err.code).toBe('E_BAD_RESULT');
  });

  it('cmd file payload contains action, params, id, ts', async () => {
    setHeartbeat({ ageMs: 1000 });
    let writtenPayload: any = null;
    setTimeout(() => {
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      writtenPayload = JSON.parse(fakeFs.get(cmdFiles[0])!);
      const id = writtenPayload.id;
      setResult(id, { id, success: true, data: {}, duration_ms: 1 });
    }, 100);

    await dispatchCommand('kill-process', { target: '5678' });
    expect(writtenPayload.action).toBe('kill-process');
    expect(writtenPayload.params).toEqual({ target: '5678' });
    expect(writtenPayload.id).toMatch(/^[a-f0-9]{16}$/);
    expect(writtenPayload.ts).toBeTypeOf('number');
  });
});

describe('elevatedWorker > action allowlist', () => {
  it('exposes the canonical 9-action set', () => {
    expect(WORKER_ACTIONS).toEqual([
      'set-service-startup',
      'stop-service',
      'start-service',
      'restart-service',
      'kill-process',
      'set-process-priority',
      'set-process-affinity',
      'suspend-process',
      'resume-process',
    ]);
  });
});

// ---------------------------------------------------------------------------
// v2.5.32 regression: launchCmd construction
// ---------------------------------------------------------------------------
//
// v2.5.30 + v2.5.31 shipped with bare `-NoProfile,-ExecutionPolicy,Bypass`
// inside `-ArgumentList @(...)`. PowerShell parses bare `-X` inside an
// array literal as the unary minus operator and the whole expression
// errors with "Missing argument in parameter list." -- which means the
// outer unelevated PS exited before Start-Process ever fired, so UAC
// never prompted, so no worker existed, so no heartbeat ever appeared.
// These tests pin the v2.5.32 fix: every token in the array literal MUST
// be wrapped in single quotes.

describe('elevatedWorker > buildLaunchCmd (v2.5.32 regression)', () => {
  const opts = {
    pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    workerScript: 'C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1',
    basePath: 'C:\\ProgramData\\PCDoctor',
    queueDir: 'C:\\Users\\someone\\AppData\\Local\\PCDoctor\\worker-queue',
  };

  it('every token inside @(...) is single-quoted (no bare -NoProfile, etc.)', () => {
    const cmd = buildLaunchCmd(opts);
    const m = cmd.match(/-ArgumentList @\((.*?)\) -Verb RunAs/);
    expect(m).not.toBeNull();
    const tokens = m![1].split(',');
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      // Each token must start AND end with a single quote. Anything bare
      // (e.g. `-NoProfile` or `Bypass`) regresses the v2.5.30 bug.
      expect(t).toMatch(/^'.*'$/);
    }
  });

  it('does NOT emit the v2.5.30/v2.5.31 broken pattern', () => {
    const cmd = buildLaunchCmd(opts);
    // The exact substring that broke production for ~24 hours.
    expect(cmd).not.toContain('@(-NoProfile');
    expect(cmd).not.toContain(',-ExecutionPolicy,');
    expect(cmd).not.toContain(',Bypass,');
  });

  it('preserves all required worker args in order', () => {
    const cmd = buildLaunchCmd(opts);
    // Sanity-check the worker still receives -File, -BasePath, -QueueDir.
    expect(cmd).toContain("'-File'");
    expect(cmd).toContain("'-BasePath'");
    expect(cmd).toContain("'-QueueDir'");
    expect(cmd).toContain(`'${opts.workerScript}'`);
    expect(cmd).toContain(`'${opts.basePath}'`);
    expect(cmd).toContain(`'${opts.queueDir}'`);
  });

  it('escapes single quotes in paths using PS doubled-single-quote rule', () => {
    const cmd = buildLaunchCmd({ ...opts, queueDir: "C:\\path with 'quote' in it\\queue" });
    // The single quote inside the path becomes '' inside the surrounding '...'.
    expect(cmd).toContain("'C:\\path with ''quote'' in it\\queue'");
  });
});
