// @vitest-environment node
//
/**
 * Module: elevatedWorker.test.ts
 * Purpose: Prove authenticated V2 worker envelopes and the fail-closed queue boundary.
 * Dependencies: Vitest plus mocked filesystem, ACL process, and launcher boundaries.
 * Used by: Focused Phase 0 safety verification.
 * Key decisions: Cryptographic expectations are literal fixtures. PowerShell behavior is
 * exercised separately by the non-elevated, temp-only worker smoke test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';

// ── Mock fs operations the dispatcher uses ─────────────────────────────────
// We hold a virtual filesystem in memory so test cases can install fake
// heartbeat/result files at the same paths the dispatcher reads. Both the
// fakeFs Map and the spawnMock fn must be defined via vi.hoisted() so the
// vi.mock factories (which are themselves hoisted to module top) can see them.
const {
  fakeFs, fakeBytes, spawnMock, execFileSyncMock, readFileSyncMock, renameSyncMock,
  openSyncMock, readSyncMock, closeSyncMock, spawnChildren, resolveScriptPathMock,
} = vi.hoisted(() => {
  const files = new Map<string, string>();
  const byteFiles = new Map<string, Buffer>();
  const handles = new Map<number, { path: string; offset: number }>();
  type ChildListener = (...args: any[]) => void;
  type FakeChild = {
    unref: ReturnType<typeof vi.fn>;
    once: (event: string, listener: ChildListener) => FakeChild;
    off: (event: string, listener: ChildListener) => FakeChild;
    emit: (event: string, ...args: any[]) => boolean;
  };
  const children: FakeChild[] = [];
  let nextHandle = 100;
  const codeTrustProof = {
    secure: true,
    base_path: 'C:\\ProgramData\\PCDoctor',
    worker_script: 'C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1',
    protected_boundary: true,
    ancestor_delete_safe: true,
    ancestor_untrusted_rights: 0,
    trusted_ancestor_owner: true,
    trusted_owner: true,
    no_reparse: true,
    no_untrusted_write: true,
    checked_files: 10,
  };
  return {
    fakeFs: files,
    fakeBytes: byteFiles,
    spawnChildren: children,
    resolveScriptPathMock: vi.fn((rel: string) => (
      `C:\\ProgramData\\PCDoctor\\${rel.replace(/\//g, '\\')}`
    )),
    spawnMock: vi.fn(() => {
      const listeners = new Map<string, Set<ChildListener>>();
      const child: FakeChild = {
        unref: vi.fn(),
        once(event, listener) {
          const onceListener: ChildListener = (...args) => {
            child.off(event, onceListener);
            listener(...args);
          };
          const eventListeners = listeners.get(event) ?? new Set<ChildListener>();
          eventListeners.add(onceListener);
          listeners.set(event, eventListeners);
          return child;
        },
        off(event, listener) {
          listeners.get(event)?.delete(listener);
          return child;
        },
        emit(event, ...args) {
          const eventListeners = Array.from(listeners.get(event) ?? []);
          for (const listener of eventListeners) listener(...args);
          return eventListeners.length > 0;
        },
      };
      children.push(child);
      return child;
    }),
    readFileSyncMock: vi.fn((p: any) => {
      const value = files.get(String(p));
      if (value === undefined) throw new Error(`ENOENT (mock): ${p}`);
      return value;
    }),
    renameSyncMock: vi.fn((source: any, destination: any) => {
      const byteValue = byteFiles.get(String(source));
      if (byteValue !== undefined) {
        byteFiles.set(String(destination), byteValue);
        byteFiles.delete(String(source));
        return;
      }
      const value = files.get(String(source));
      if (value === undefined) throw new Error(`ENOENT (mock): ${source}`);
      files.set(String(destination), value);
      files.delete(String(source));
    }),
    openSyncMock: vi.fn((p: any) => {
      const filePath = String(p);
      if (!files.has(filePath) && !byteFiles.has(filePath)) throw new Error(`ENOENT (mock): ${p}`);
      const handle = nextHandle;
      nextHandle += 1;
      handles.set(handle, { path: filePath, offset: 0 });
      return handle;
    }),
    readSyncMock: vi.fn((handle: number, buffer: Buffer, offset: number, length: number) => {
      const entry = handles.get(handle);
      if (!entry) throw new Error(`EBADF (mock): ${handle}`);
      const source = byteFiles.get(entry.path) ?? Buffer.from(files.get(entry.path) ?? '', 'utf8');
      const count = Math.min(length, Math.max(0, source.length - entry.offset));
      source.copy(buffer, offset, entry.offset, entry.offset + count);
      entry.offset += count;
      return count;
    }),
    closeSyncMock: vi.fn((handle: number) => { handles.delete(handle); }),
    execFileSyncMock: vi.fn(() => JSON.stringify({
      ...codeTrustProof,
      user_sid: 'S-1-5-21-1000',
      protected: true,
      allowed_sids: ['S-1-5-21-1000', 'S-1-5-32-544', 'S-1-5-18'],
    })),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn((p: any) => fakeFs.has(String(p)) || fakeBytes.has(String(p))),
    readFileSync: readFileSyncMock,
    writeFileSync: vi.fn((p: any, data: any) => {
      fakeFs.set(String(p), String(data));
    }),
    rmSync: vi.fn((p: any) => {
      fakeFs.delete(String(p));
      fakeBytes.delete(String(p));
    }),
    renameSync: renameSyncMock,
    openSync: openSyncMock,
    readSync: readSyncMock,
    closeSync: closeSyncMock,
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
  resolveScriptPath: resolveScriptPathMock,
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
    execFileSync: execFileSyncMock,
  };
});

import {
  WORKER_ACTIONS,
  ElevatedWorkerError,
  readHeartbeat,
  isWorkerAlive,
  ensureWorkerRunning,
  dispatchCommand,
  buildLaunchCmd,
  getQueueDir,
  _testing,
} from '@main/elevatedWorker.js';
import {
  WORKER_ACTION_CONTRACTS,
  WORKER_ARTIFACT_MAX_BYTES,
  canonicalizeJson,
  signHeartbeatFields,
  signEnvelopeFields,
  signResultFields,
  validateHeartbeat,
  validateEnvelope,
  validateResultEnvelope,
} from '@main/elevatedWorkerProtocol.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clearFs() {
  fakeFs.clear();
  fakeBytes.clear();
}

function queueAclProof(
  scope: 'root' | 'leaf' = 'root',
  overrides: Record<string, unknown> = {},
): string {
  const session = _testing.getWorkerSessionForTests();
  return JSON.stringify({
    secure: true,
    scope,
    queue_root: 'C:\\ProgramData\\PCDoctorWorkerQueue',
    queue_dir: scope === 'root' ? null : session.queueDir,
    owner_sid: 'S-1-5-32-544',
    user_sid: 'S-1-5-21-1000',
    protected: true,
    allowed_sids: ['S-1-5-21-1000', 'S-1-5-32-544', 'S-1-5-18'],
    no_reparse: true,
    trusted_owner: true,
    trusted_ancestor_owner: true,
    no_untrusted_write: true,
    ancestor_delete_safe: true,
    ...overrides,
  });
}

function mutateQueueAclProof(
  scope: 'root' | 'leaf',
  mutate: (proof: Record<string, unknown>) => void,
): string {
  const proof = JSON.parse(queueAclProof(scope)) as Record<string, unknown>;
  mutate(proof);
  return JSON.stringify(proof);
}

function codeTrustProof(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    secure: true,
    base_path: 'C:\\ProgramData\\PCDoctor',
    worker_script: 'C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1',
    protected_boundary: true,
    ancestor_delete_safe: true,
    ancestor_untrusted_rights: 0,
    trusted_ancestor_owner: true,
    trusted_owner: true,
    no_reparse: true,
    no_untrusted_write: true,
    checked_files: 10,
    ...overrides,
  });
}

function heartbeatPath(): string {
  return _testing.getHeartbeatPath();
}

function setHeartbeat(opts: { ageMs?: number; pid?: number } = {}) {
  const last = Date.now() - (opts.ageMs ?? 0);
  const session = _testing.getWorkerSessionForTests();
  const heartbeat = signHeartbeatFields({
    version: 2,
    session_id: session.sessionId,
    worker_pid: opts.pid ?? 1234,
    issued_at: last,
    expires_at: last + 30_000,
    nonce: 'dddddddddddddddddddddddddddddddd',
  }, session.capability);
  fakeFs.set(heartbeatPath(), JSON.stringify(heartbeat));
}

function setResult(
  id: string,
  payload: {
    success: boolean;
    duration_ms: number;
    data?: unknown;
    error?: { code: string; message: string };
  },
  overrides: Record<string, unknown> = {},
) {
  const session = _testing.getWorkerSessionForTests();
  const command = JSON.parse(fakeFs.get(_testing.getCmdPath(id))!);
  const unsigned = {
    version: 2,
    session_id: session.sessionId,
    id,
    action: command.action,
    success: payload.success,
    duration_ms: payload.duration_ms,
    ...(payload.success ? { data: payload.data ?? null } : { error: payload.error }),
    issued_at: Date.now(),
    nonce: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    ...overrides,
  };
  const result = signResultFields(unsigned, session.capability);
  fakeFs.set(_testing.getResultPath(id), JSON.stringify(result));
}

function resetBoundary(): void {
  clearFs();
  spawnMock.mockClear();
  spawnChildren.length = 0;
  resolveScriptPathMock.mockClear();
  resolveScriptPathMock.mockImplementation((rel: string) => (
    `C:\\ProgramData\\PCDoctor\\${rel.replace(/\//g, '\\')}`
  ));
  readFileSyncMock.mockClear();
  renameSyncMock.mockClear();
  execFileSyncMock.mockReset();
  _testing.resetWorkerSessionForTests();
  execFileSyncMock.mockImplementation((...args: any[]) => {
    const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
    const scope = options?.env?.PCDOCTOR_QUEUE_PROOF_SCOPE;
    if (scope === 'root' || scope === 'leaf') return queueAclProof(scope);
    return codeTrustProof();
  });
}

const FIXTURE_CAPABILITY = Buffer.from(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  'hex',
);
const FIXTURE_NOW = 1_770_000_001_000;
const FIXTURE_UNSIGNED = {
  version: 2,
  session_id: '00112233445566778899aabbccddeeff',
  id: 'ffeeddccbbaa99887766554433221100',
  action: 'set-service-startup',
  params: { startup_type: 'Disabled', service: 'Spooler' },
  issued_at: 1_770_000_000_000,
  expires_at: 1_770_000_025_000,
  nonce: '0123456789abcdeffedcba9876543210',
} as const;
const FIXTURE_CANONICAL = '{"action":"set-service-startup","expires_at":1770000025000,'
  + '"id":"ffeeddccbbaa99887766554433221100","issued_at":1770000000000,'
  + '"nonce":"0123456789abcdeffedcba9876543210","params":{"service":"Spooler",'
  + '"startup_type":"Disabled"},"session_id":"00112233445566778899aabbccddeeff",'
  + '"version":2}';
const FIXTURE_HMAC = 'd10c2b6eec700463d16d59144aaa075962db31d1826422ad9007e9c670af2e8f';
const HEARTBEAT_FIXTURE_CANONICAL = '{"expires_at":1770000020000,"issued_at":1770000000000,'
  + '"nonce":"11111111111111111111111111111111",'
  + '"session_id":"00112233445566778899aabbccddeeff","version":2,"worker_pid":4242}';
const HEARTBEAT_FIXTURE_HMAC = '7bfa511655f923bed47397d90e1ddad811f92269a26aa0904b74ce174c3a8a19';
const RESULT_FIXTURE_CANONICAL = '{"action":"stop-service","data":{"after":"Stopped"},'
  + '"duration_ms":17,"id":"ffeeddccbbaa99887766554433221100",'
  + '"issued_at":1770000000000,"nonce":"22222222222222222222222222222222",'
  + '"session_id":"00112233445566778899aabbccddeeff","success":true,"version":2}';
const RESULT_FIXTURE_HMAC = '30890000fa5c3ed73d5c85a67d664de54ddcd78903eca692276395be61f83417';

function signedFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return signEnvelopeFields(
    { ...FIXTURE_UNSIGNED, ...overrides },
    FIXTURE_CAPABILITY,
  ) as unknown as Record<string, unknown>;
}

function validationContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capability: FIXTURE_CAPABILITY,
    sessionId: FIXTURE_UNSIGNED.session_id,
    now: FIXTURE_NOW,
    acceptedNonces: new Set<string>(),
    ...overrides,
  };
}

function expectEnvelopeError(
  envelope: unknown,
  code: string,
  context: Record<string, unknown> = validationContext(),
): void {
  let thrown: unknown;
  try {
    validateEnvelope(envelope, context);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ElevatedWorkerError);
  expect((thrown as ElevatedWorkerError).code).toBe(code);
}

function syntheticContracts(rebootPolicy: 'never' | 'restart' = 'never'): Record<string, unknown> {
  return {
    ...WORKER_ACTION_CONTRACTS,
    'test-safe-automatic': {
      automation: 'safe',
      rebootPolicy,
      manualAllowed: false,
      required: {
        value: { type: 'string', nonEmpty: true },
      },
      optional: {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('elevatedWorker > canonical JSON and authenticated V2 envelope', () => {
  beforeEach(resetBoundary);

  it('matches a hand-derived literal canonical JSON and HMAC fixture', () => {
    expect(canonicalizeJson(FIXTURE_UNSIGNED)).toBe(FIXTURE_CANONICAL);
    const envelope = signedFixture();
    expect(envelope.hmac_sha256).toBe(FIXTURE_HMAC);
  });

  it('recursively sorts object keys, preserves array order, and emits UTF-8 JSON text', () => {
    const value = {
      z: 'café',
      a: [{ z: null, a: false }, 'line\nquote"'],
    };
    expect(canonicalizeJson(value)).toBe(
      '{"a":[{"a":false,"z":null},"line\\nquote\\\""],"z":"café"}',
    );
  });

  it.each([
    ['undefined value', { ...FIXTURE_UNSIGNED, params: { service: undefined } }],
    ['non-finite number', { value: Number.NaN }],
    ['fractional number', { value: 1.5 }],
    ['negative zero', { value: -0 }],
    ['sparse array', { value: new Array(1) }],
    ['lone surrogate', { value: '\ud800' }],
  ])('rejects ambiguous or non-contract JSON: %s', (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(ElevatedWorkerError);
  });

  it.each([
    ['accessor property', () => {
      const value = {} as Record<string, unknown>;
      Object.defineProperty(value, 'secret', { enumerable: true, get: () => 'value' });
      return value;
    }],
    ['proxy object', () => new Proxy({ value: 1 }, {})],
    ['cyclic object', () => {
      const value: Record<string, unknown> = {};
      value.self = value;
      return value;
    }],
    ['symbol key', () => ({ value: 1, [Symbol('hidden')]: 2 })],
    ['extended array', () => {
      const value = [1];
      Object.defineProperty(value, 'extra', { enumerable: true, value: 2 });
      return value;
    }],
  ])('rejects an ambiguous object structure: %s', (_label, createValue) => {
    expect(() => canonicalizeJson(createValue())).toThrow(ElevatedWorkerError);
  });

  it.each([
    ['extra envelope field', (envelope: Record<string, unknown>) => {
      envelope.extra = true;
    }],
    ['missing envelope field', (envelope: Record<string, unknown>) => {
      delete envelope.nonce;
    }],
  ])('rejects an envelope with an %s', (_label, mutate) => {
    const envelope = { ...signedFixture() };
    mutate(envelope);
    expectEnvelopeError(envelope, 'E_BAD_ENVELOPE');
  });

  it('accepts a valid manual service envelope', () => {
    const envelope = signedFixture();
    const accepted = validateEnvelope(envelope, validationContext());
    expect(accepted).toEqual(envelope);
  });

  it('rejects malformed HMAC in constant-shape validation', () => {
    expectEnvelopeError(
      { ...signedFixture(), hmac_sha256: '0'.repeat(64) },
      'E_BAD_HMAC',
    );
  });

  it('rejects a session mismatch', () => {
    expectEnvelopeError(
      signedFixture(),
      'E_WRONG_SESSION',
      validationContext({ sessionId: '11112222333344445555666677778888' }),
    );
  });

  it.each([
    ['expired', { expires_at: FIXTURE_NOW }, 'E_ENVELOPE_EXPIRED'],
    ['issued too far in the future', {
      issued_at: FIXTURE_NOW + 5_001,
      expires_at: FIXTURE_NOW + 20_000,
    }, 'E_ENVELOPE_FUTURE'],
    ['lifetime over 30 seconds', {
      issued_at: FIXTURE_NOW,
      expires_at: FIXTURE_NOW + 30_001,
    }, 'E_ENVELOPE_LIFETIME'],
  ])('rejects an envelope that is %s', (_label, overrides, code) => {
    expectEnvelopeError(signedFixture(overrides), code);
  });

  it('retains accepted nonces and rejects replay before a second dispatch', () => {
    const acceptedNonces = new Set<string>();
    const context = validationContext({ acceptedNonces });
    const envelope = signedFixture();
    validateEnvelope(envelope, context);
    expect(acceptedNonces.has(FIXTURE_UNSIGNED.nonce)).toBe(true);
    expectEnvelopeError(envelope, 'E_REPLAY', context);
  });

  it('does not consume a command nonce until authentication succeeds', () => {
    const acceptedNonces = new Set<string>();
    const context = validationContext({ acceptedNonces });
    const envelope = signedFixture();

    expectEnvelopeError(
      { ...envelope, hmac_sha256: '0'.repeat(64) },
      'E_BAD_HMAC',
      context,
    );
    expect(acceptedNonces).toEqual(new Set());

    validateEnvelope(envelope, context);
    expect(acceptedNonces).toEqual(new Set([FIXTURE_UNSIGNED.nonce]));
  });

  it.each([
    ['set-service-startup', { service: 'Spooler', startup_type: 'Disabled' }],
    ['stop-service', { service: 'Spooler' }],
    ['start-service', { service: 'Spooler' }],
    ['restart-service', { service: 'Spooler' }],
    ['kill-process', { target: 'notepad' }],
    ['set-process-priority', { target: 123, class: 'High' }],
    ['set-process-affinity', { target: 123, mask: 3 }],
    ['suspend-process', { target: 123 }],
    ['resume-process', { target: 123 }],
  ])('accepts the exact manual parameter contract for %s', (action, params) => {
    const envelope = signedFixture({ action, params: { ...params, dry_run: true } });
    const accepted = validateEnvelope(envelope, validationContext());
    expect(accepted.params).toEqual({ ...params, dry_run: true });
  });

  it.each(['A', 'aZ09._-', 'A'.repeat(128)])(
    'accepts the complete bounded safe-name domain boundary: %s',
    (value) => {
      expect(validateEnvelope(
        signedFixture({ action: 'stop-service', params: { service: value } }),
        validationContext(),
      ).params).toEqual({ service: value });
      expect(validateEnvelope(
        signedFixture({ action: 'kill-process', params: { target: value } }),
        validationContext(),
      ).params).toEqual({ target: value });
    },
  );

  it.each([
    ['blank service', 'stop-service', { service: '   ' }],
    ['service wildcard star', 'stop-service', { service: '*' }],
    ['service wildcard question', 'start-service', { service: 'Spool?er' }],
    ['service wildcard brackets', 'restart-service', { service: 'Spool[er]' }],
    ['service slash', 'stop-service', { service: 'bad/name' }],
    ['service backslash', 'stop-service', { service: 'bad\\name' }],
    ['service whitespace', 'stop-service', { service: 'bad name' }],
    ['service newline', 'stop-service', { service: 'bad\nname' }],
    ['service trailing LF', 'stop-service', { service: 'badname\n' }],
    ['service max length plus trailing LF', 'stop-service', { service: `${'A'.repeat(128)}\n` }],
    ['service non-ASCII', 'stop-service', { service: 'café' }],
    ['service over 128 characters', 'stop-service', { service: 'a'.repeat(129) }],
    ['kill wildcard star', 'kill-process', { target: '*' }],
    ['kill wildcard question', 'kill-process', { target: 'note?ad' }],
    ['kill wildcard brackets', 'kill-process', { target: 'note[pad]' }],
    ['kill slash', 'kill-process', { target: 'bad/name' }],
    ['kill whitespace', 'kill-process', { target: 'bad name' }],
    ['kill semicolon', 'kill-process', { target: 'bad;name' }],
    ['kill newline', 'kill-process', { target: 'bad\nname' }],
    ['kill trailing LF', 'kill-process', { target: 'badname\n' }],
    ['kill over 128 characters', 'kill-process', { target: 'a'.repeat(129) }],
    ['wrong-case startup type', 'set-service-startup', {
      service: 'Spooler', startup_type: 'disabled',
    }],
    ['numeric process name', 'kill-process', { target: 123 }],
    ['zero process id', 'set-process-priority', { target: 0, class: 'High' }],
    ['wrong-case priority class', 'set-process-priority', { target: 123, class: 'Realtime' }],
    ['zero affinity mask', 'set-process-affinity', { target: 123, mask: 0 }],
    ['out-of-range process id', 'set-process-affinity', { target: 2_147_483_648, mask: 3 }],
    ['string process id', 'suspend-process', { target: '123' }],
  ])('rejects an exact action-contract violation: %s', (_label, action, params) => {
    expectEnvelopeError(signedFixture({ action, params }), 'E_INVALID_PARAMS');
  });

  it.each([
    ['unknown parameter', { service: 'Spooler', startup_type: 'Disabled', path: 'C:\\evil.ps1' }],
    ['missing parameter', { service: 'Spooler' }],
    ['wrong parameter type', { service: 'Spooler', startup_type: 3 }],
  ])('rejects action-specific params with an %s', (_label, params) => {
    expectEnvelopeError(signedFixture({ params }), 'E_INVALID_PARAMS');
  });

  it.each(['toString', '__proto__'])('rejects inherited object names as unknown actions: %s', (action) => {
    expectEnvelopeError(signedFixture({ action, params: {} }), 'E_INVALID_ACTION');
  });

  it.each([
    ['action', (envelope: Record<string, unknown>) => { envelope.action = 'stop-service'; }],
    ['params', (envelope: Record<string, unknown>) => {
      envelope.params = { service: 'BITS', startup_type: 'Disabled' };
    }],
  ])('rejects a signed envelope after %s tampering', (_label, tamper) => {
    const envelope = { ...signedFixture() };
    tamper(envelope);
    expectEnvelopeError(envelope, 'E_BAD_HMAC');
  });

  it('copies and recursively freezes params before signing', () => {
    const params = { service: 'Spooler', startup_type: 'Disabled' };
    const envelope = signEnvelopeFields(
      { ...FIXTURE_UNSIGNED, params },
      FIXTURE_CAPABILITY,
    );
    params.service = 'BITS';
    expect(envelope.params).toEqual({ service: 'Spooler', startup_type: 'Disabled' });
    expect(Object.isFrozen(envelope)).toBe(true);
    expect(Object.isFrozen(envelope.params)).toBe(true);
  });

  it('denies a synthetic automatic-only action without policy and intent capability', () => {
    const envelope = signedFixture({
      action: 'test-safe-automatic',
      params: { value: 'ok' },
    });
    expectEnvelopeError(
      envelope,
      'E_AUTOMATIC_CAPABILITY_REQUIRED',
      validationContext({ contracts: syntheticContracts() }),
    );
  });

  it('accepts a fully bound synthetic automatic envelope only in pure validation', () => {
    const envelope = signedFixture({
      action: 'test-safe-automatic',
      params: { value: 'ok' },
      policy_id: 'policy-123',
      intent_id: 'intent-456',
    });
    const accepted = validateEnvelope(
      envelope,
      validationContext({ contracts: syntheticContracts() }),
    );
    expect(accepted.policy_id).toBe('policy-123');
    expect(accepted.intent_id).toBe('intent-456');
  });

  it('rejects automatic authority on every current manual-only action', () => {
    const envelope = signedFixture({ policy_id: 'forged-policy', intent_id: 'forged-intent' });
    expectEnvelopeError(envelope, 'E_AUTOMATION_NEVER');
  });

  it('rejects an automatic contract unless rebootPolicy remains never', () => {
    const envelope = signedFixture({
      action: 'test-safe-automatic',
      params: { value: 'ok' },
      policy_id: 'policy-123',
      intent_id: 'intent-456',
    });
    expectEnvelopeError(
      envelope,
      'E_REBOOT_FORBIDDEN',
      validationContext({ contracts: syntheticContracts('restart') }),
    );
  });

  it('rejects reboot actions independently of the ordinary allowlist', () => {
    const envelope = signedFixture({ action: 'reboot', params: {} });
    expectEnvelopeError(envelope, 'E_REBOOT_FORBIDDEN');
  });
});

describe('elevatedWorker > authenticated heartbeat and result artifacts', () => {
  beforeEach(resetBoundary);

  it('matches hand-derived literal heartbeat canonical JSON and HMAC', () => {
    const unsigned = {
      version: 2,
      session_id: FIXTURE_UNSIGNED.session_id,
      worker_pid: 4242,
      issued_at: 1_770_000_000_000,
      expires_at: 1_770_000_020_000,
      nonce: '11111111111111111111111111111111',
    };
    expect(canonicalizeJson(unsigned)).toBe(HEARTBEAT_FIXTURE_CANONICAL);
    const heartbeat = signHeartbeatFields(unsigned, FIXTURE_CAPABILITY);
    expect(heartbeat.hmac_sha256).toBe(HEARTBEAT_FIXTURE_HMAC);
    expect(validateHeartbeat(heartbeat, {
      capability: FIXTURE_CAPABILITY,
      sessionId: FIXTURE_UNSIGNED.session_id,
      now: FIXTURE_NOW,
    })).toEqual(heartbeat);
  });

  it('matches hand-derived literal result canonical JSON and HMAC', () => {
    const unsigned = {
      version: 2,
      session_id: FIXTURE_UNSIGNED.session_id,
      id: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      success: true,
      data: { after: 'Stopped' },
      duration_ms: 17,
      issued_at: 1_770_000_000_000,
      nonce: '22222222222222222222222222222222',
    };
    expect(canonicalizeJson(unsigned)).toBe(RESULT_FIXTURE_CANONICAL);
    const result = signResultFields(unsigned, FIXTURE_CAPABILITY);
    expect(result.hmac_sha256).toBe(RESULT_FIXTURE_HMAC);
    expect(validateResultEnvelope(result, {
      capability: FIXTURE_CAPABILITY,
      sessionId: FIXTURE_UNSIGNED.session_id,
      commandId: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      now: FIXTURE_NOW,
      acceptedNonces: new Set<string>(),
    })).toEqual(result);
  });

  it.each([
    ['tampered pid', (heartbeat: Record<string, unknown>) => { heartbeat.worker_pid = 9999; }],
    ['tampered HMAC', (heartbeat: Record<string, unknown>) => { heartbeat.hmac_sha256 = '0'.repeat(64); }],
  ])('rejects a %s heartbeat', (_label, tamper) => {
    setHeartbeat({ ageMs: 1_000 });
    const heartbeat = JSON.parse(fakeFs.get(heartbeatPath())!);
    tamper(heartbeat);
    fakeFs.set(heartbeatPath(), JSON.stringify(heartbeat));
    expect(readHeartbeat()).toBeNull();
    expect(isWorkerAlive()).toBe(false);
  });

  it('rejects a correctly signed heartbeat from another session', () => {
    const session = _testing.getWorkerSessionForTests();
    const issuedAt = Date.now() - 1_000;
    const heartbeat = signHeartbeatFields({
      version: 2,
      session_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      worker_pid: 1234,
      issued_at: issuedAt,
      expires_at: issuedAt + 30_000,
      nonce: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }, session.capability);
    fakeFs.set(heartbeatPath(), JSON.stringify(heartbeat));
    expect(readHeartbeat()).toBeNull();
    expect(isWorkerAlive()).toBe(false);
  });

  it('rejects a heartbeat artifact containing malformed UTF-8 bytes', () => {
    setHeartbeat({ ageMs: 1_000 });
    const valid = Buffer.from(fakeFs.get(heartbeatPath())!, 'utf8');
    fakeFs.delete(heartbeatPath());
    fakeBytes.set(heartbeatPath(), Buffer.concat([
      valid.subarray(0, 1), Buffer.from([0xc3, 0x28]), valid.subarray(1),
    ]));

    expect(() => _testing.readBoundedUtf8ForTests(
      heartbeatPath(), WORKER_ARTIFACT_MAX_BYTES,
    )).toThrowError(expect.objectContaining({ code: 'E_ARTIFACT_ENCODING' }));
    expect(readHeartbeat()).toBeNull();
    expect(isWorkerAlive()).toBe(false);
  });

  it('preserves and rejects a noncanonical UTF-8 BOM on a heartbeat artifact', () => {
    setHeartbeat({ ageMs: 1_000 });
    const valid = Buffer.from(fakeFs.get(heartbeatPath())!, 'utf8');
    fakeFs.delete(heartbeatPath());
    fakeBytes.set(heartbeatPath(), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]));

    expect(_testing.readBoundedUtf8ForTests(
      heartbeatPath(), WORKER_ARTIFACT_MAX_BYTES,
    ).startsWith('\ufeff')).toBe(true);
    expect(readHeartbeat()).toBeNull();
    expect(isWorkerAlive()).toBe(false);
  });

  it('rejects result nonce replay without letting failed authentication consume the nonce', () => {
    const unsigned = {
      version: 2,
      session_id: FIXTURE_UNSIGNED.session_id,
      id: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      success: true,
      data: { after: 'Stopped' },
      duration_ms: 17,
      issued_at: 1_770_000_000_000,
      nonce: '33333333333333333333333333333333',
    };
    const result = signResultFields(unsigned, FIXTURE_CAPABILITY);
    const acceptedNonces = new Set<string>();
    const context = {
      capability: FIXTURE_CAPABILITY,
      sessionId: FIXTURE_UNSIGNED.session_id,
      commandId: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      now: FIXTURE_NOW,
      acceptedNonces,
    };

    let forgedError: unknown;
    try {
      validateResultEnvelope({ ...result, hmac_sha256: '0'.repeat(64) }, context);
    } catch (error) {
      forgedError = error;
    }
    expect(forgedError).toBeInstanceOf(ElevatedWorkerError);
    expect((forgedError as ElevatedWorkerError).code).toBe('E_BAD_HMAC');
    expect(acceptedNonces).toEqual(new Set());

    validateResultEnvelope(result, context);
    expect(acceptedNonces).toEqual(new Set([unsigned.nonce]));

    let replayError: unknown;
    try {
      validateResultEnvelope(result, context);
    } catch (error) {
      replayError = error;
    }
    expect(replayError).toBeInstanceOf(ElevatedWorkerError);
    expect((replayError as ElevatedWorkerError).code).toBe('E_REPLAY');
  });

  it('rejects extra heartbeat fields before treating the worker as alive', () => {
    const session = _testing.getWorkerSessionForTests();
    const issuedAt = Date.now() - 1_000;
    const heartbeat = signHeartbeatFields({
      version: 2,
      session_id: session.sessionId,
      worker_pid: 1234,
      issued_at: issuedAt,
      expires_at: issuedAt + 30_000,
      nonce: '44444444444444444444444444444444',
    }, session.capability);

    expect(() => validateHeartbeat({ ...heartbeat, extra: true }, {
      capability: session.capability,
      sessionId: session.sessionId,
      now: Date.now(),
    })).toThrowError(expect.objectContaining({ code: 'E_BAD_HEARTBEAT' }));
  });

  it.each([
    ['success with both data and error', {
      success: true,
      data: { state: 'Stopped' },
      error: { code: 'E_CONFLICT', message: 'both branches supplied' },
    }],
    ['failure without an error', { success: false }],
    ['failure with an empty error code', {
      success: false,
      error: { code: '', message: 'missing code' },
    }],
  ])('rejects an invalid exact result union: %s', (_label, unionFields) => {
    const result = signResultFields({
      version: 2,
      session_id: FIXTURE_UNSIGNED.session_id,
      id: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      duration_ms: 17,
      issued_at: 1_770_000_000_000,
      nonce: '55555555555555555555555555555555',
      ...unionFields,
    }, FIXTURE_CAPABILITY);

    expect(() => validateResultEnvelope(result, {
      capability: FIXTURE_CAPABILITY,
      sessionId: FIXTURE_UNSIGNED.session_id,
      commandId: FIXTURE_UNSIGNED.id,
      action: 'stop-service',
      now: FIXTURE_NOW,
      acceptedNonces: new Set<string>(),
    })).toThrowError(expect.objectContaining({ code: 'E_BAD_RESULT' }));
  });
});

describe('elevatedWorker > heartbeat', () => {
  beforeEach(resetBoundary);

  it('readHeartbeat returns null when file missing', () => {
    expect(readHeartbeat()).toBeNull();
  });

  it('readHeartbeat returns the parsed object when file present', () => {
    setHeartbeat({ pid: 9999 });
    const hb = readHeartbeat();
    expect(hb?.worker_pid).toBe(9999);
    expect(hb?.version).toBe(2);
  });

  it('readHeartbeat returns null on malformed JSON', () => {
    fakeFs.set(heartbeatPath(), '{not valid json');
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

  it('rejects an oversized heartbeat before the legacy unbounded read', () => {
    fakeFs.set(heartbeatPath(), 'x'.repeat(WORKER_ARTIFACT_MAX_BYTES + 1));
    readFileSyncMock.mockClear();
    expect(readHeartbeat()).toBeNull();
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it('isWorkerAlive false when a fresh heartbeat belongs to another session', () => {
    setHeartbeat({ ageMs: 1_000 });
    const heartbeat = JSON.parse(fakeFs.get(heartbeatPath())!);
    heartbeat.session_id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    fakeFs.set(heartbeatPath(), JSON.stringify(heartbeat));
    expect(isWorkerAlive()).toBe(false);
  });
});

describe('elevatedWorker > ensureWorkerRunning', () => {
  beforeEach(resetBoundary);

  it('derives the authenticated session leaf directly beneath the fixed queue root', () => {
    const session = _testing.getWorkerSessionForTests();
    expect(getQueueDir()).toBe('C:\\ProgramData\\PCDoctorWorkerQueue');
    expect(session.queueDir).toBe(`${getQueueDir()}\\${session.sessionId}`);
    expect(path.win32.basename(session.queueDir)).toBe(session.sessionId);
    expect(path.win32.dirname(session.queueDir)).toBe(getQueueDir());
  });

  it('models atomic Node publication without directory replacement rights', () => {
    const model = (_testing as any).QUEUE_USER_ACL_MODEL as {
      directoryRights: number;
      fileRights: number;
      directoryInheritanceFlags: number;
      fileInheritanceFlags: number;
      filePropagationFlags: number;
    };
    expect(model).toBeDefined();

    const LIST_DIRECTORY = 1;
    const CREATE_FILES = 2;
    const CREATE_DIRECTORIES = 4;
    const WRITE_EXTENDED_ATTRIBUTES = 16;
    const DELETE_CHILD = 64;
    const WRITE_ATTRIBUTES = 256;
    const DELETE = 65_536;
    const CHANGE_PERMISSIONS = 262_144;
    const TAKE_OWNERSHIP = 524_288;
    const CONTAINER_INHERIT = 1;
    const OBJECT_INHERIT = 2;
    const INHERIT_ONLY = 2;

    expect(model.directoryRights & LIST_DIRECTORY).toBe(LIST_DIRECTORY);
    expect(model.directoryRights & CREATE_FILES).toBe(CREATE_FILES);
    expect(model.directoryRights & (CREATE_DIRECTORIES | WRITE_EXTENDED_ATTRIBUTES
      | DELETE_CHILD | WRITE_ATTRIBUTES | DELETE | CHANGE_PERMISSIONS
      | TAKE_OWNERSHIP)).toBe(0);
    expect(model.directoryInheritanceFlags).toBe(0);

    // Same-directory temp creation uses CreateFiles. Rename/delete of that
    // temp is authorized only on the inherited child file, never the directory.
    expect(model.fileRights & DELETE).toBe(DELETE);
    expect(model.fileInheritanceFlags & OBJECT_INHERIT).toBe(OBJECT_INHERIT);
    expect(model.fileInheritanceFlags & CONTAINER_INHERIT).toBe(0);
    expect(model.filePropagationFlags & INHERIT_ONLY).toBe(INHERIT_ONLY);
  });

  it('fails closed before UAC when the installer-owned queue root is unavailable', async () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('fixed queue root missing');
    });

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ROOT_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

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

  it('shares one launch attempt across concurrent readiness checks', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    const first = ensureWorkerRunning();
    const second = ensureWorkerRunning();

    expect(second).toBe(first);
    await Promise.all([first, second]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('passes a 32-byte capability only in the dedicated launcher child environment', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    const parentValue = process.env[_testing.CAPABILITY_ENV];
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    await ensureWorkerRunning();

    const [file, args, opts] = spawnMock.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    const capabilityText = opts.env[_testing.CAPABILITY_ENV];
    expect(file).toBe('powershell.exe');
    expect(capabilityText).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(Buffer.from(capabilityText!, 'base64')).toHaveLength(32);
    expect(args.join(' ')).not.toContain(capabilityText);
    expect(buildLaunchCmd({
      pwsh: 'pwsh.exe',
      workerScript: 'worker.ps1',
      basePath: 'base',
      queueRoot: 'queue',
      sessionId: '00112233445566778899aabbccddeeff',
      queueUserSid: 'S-1-5-21-1000',
    })).not.toContain(capabilityText);
    expect(process.env[_testing.CAPABILITY_ENV]).toBe(parentValue);
  });

  it('uses strict minimal environments for proof helpers and the UAC launcher', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    const hostileKeys = [
      'COR_ENABLE_PROFILING',
      'COR_PROFILER',
      'COMPLUS_ProfAPI_ProfilerCompatibilitySetting',
      'NODE_OPTIONS',
    ];
    const previous = new Map(hostileKeys.map((key) => [key, process.env[key]]));
    const previousModulePath = process.env.PSModulePath;
    for (const key of hostileKeys) process.env[key] = 'hostile-parent-value';
    process.env.PSModulePath = 'C:\\Users\\attacker\\Modules';
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    try {
      await ensureWorkerRunning();

      const proofEnvironments = execFileSyncMock.mock.calls.slice(0, 2).map((call) => (
        (call[2] as { env?: NodeJS.ProcessEnv }).env
      ));
      const leafProofEnvironment = execFileSyncMock.mock.calls.map((call) => (
        (call[2] as { env?: NodeJS.ProcessEnv }).env
      )).find((environment) => environment?.PCDOCTOR_QUEUE_PROOF_SCOPE === 'leaf');
      const launcherEnvironment = (
        spawnMock.mock.calls[0][2] as { env: NodeJS.ProcessEnv }
      ).env;
      expect(leafProofEnvironment).toBeDefined();
      const environments = [...proofEnvironments, leafProofEnvironment, launcherEnvironment];
      for (const childEnvironment of environments) {
        expect(childEnvironment).toBeDefined();
        for (const key of hostileKeys) expect(childEnvironment?.[key]).toBeUndefined();
        expect(childEnvironment?.PSModulePath).not.toContain('C:\\Users\\attacker');
      }

      const baseKeys = [
        'ComSpec', 'PATH', 'PATHEXT', 'PSModulePath', 'SystemDrive',
        'SystemRoot', 'TEMP', 'TMP', 'WINDIR',
      ];
      expect(Object.keys(proofEnvironments[0]!).sort()).toEqual([
        ...baseKeys, 'PCDOCTOR_QUEUE_PROOF_SCOPE',
      ].sort());
      expect(Object.keys(proofEnvironments[1]!).sort()).toEqual(baseKeys.sort());
      expect(Object.keys(leafProofEnvironment!).sort()).toEqual([
        ...baseKeys, 'PCDOCTOR_QUEUE_PROOF_SCOPE', 'PCDOCTOR_QUEUE_SESSION_ID',
      ].sort());
      expect(leafProofEnvironment?.PCDOCTOR_QUEUE_SESSION_ID).toBe(
        _testing.getWorkerSessionForTests().sessionId,
      );
      expect(Object.keys(launcherEnvironment).sort()).toEqual([
        ...baseKeys, _testing.CAPABILITY_ENV,
      ].sort());
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (previousModulePath === undefined) delete process.env.PSModulePath;
      else process.env.PSModulePath = previousModulePath;
    }
  });

  it('does not expose the session capability outside a test runtime', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => _testing.getWorkerSessionForTests()).toThrowError(
        expect.objectContaining({ code: 'E_TEST_ONLY' }),
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('fails closed before spawn when queue-root trust verification throws', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('simulated ACL setup failure');
    });

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ROOT_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails closed before spawn when effective queue-root trust verification denies', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    execFileSyncMock.mockReturnValueOnce(queueAclProof('root', {
      secure: false,
      protected: false,
    }));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ROOT_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['root reparse point', { no_reparse: false }],
    ['untrusted root owner', { trusted_owner: false }],
    ['non-Administrators root owner', { owner_sid: 'S-1-5-18' }],
    ['untrusted ancestor owner', { trusted_ancestor_owner: false }],
    ['untrusted root write', { no_untrusted_write: false }],
    ['replaceable ancestor', { ancestor_delete_safe: false }],
    ['wrong proof scope', { scope: 'leaf' }],
    ['wrong fixed root', { queue_root: 'C:\\Users\\attacker\\queue' }],
    ['unexpected root leaf path', { queue_dir: 'C:\\ProgramData\\PCDoctorWorkerQueue\\bad' }],
  ])('rejects an exact queue-root proof violation: %s', async (_label, overrides) => {
    execFileSyncMock.mockReturnValueOnce(queueAclProof('root', overrides));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ROOT_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing required field', (proof: Record<string, unknown>) => { delete proof.no_reparse; }],
    ['an unexpected extra field', (proof: Record<string, unknown>) => { proof.extra = true; }],
  ])('rejects a queue-root proof with %s', async (_label, mutate) => {
    execFileSyncMock.mockReturnValueOnce(mutateQueueAclProof('root', mutate));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ROOT_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not accept a heartbeat until the elevated-created leaf proof succeeds', async () => {
    const failedSession = _testing.getWorkerSessionForTests();
    execFileSyncMock.mockImplementation((...args: any[]) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      const scope = options?.env?.PCDOCTOR_QUEUE_PROOF_SCOPE;
      if (scope === 'root') return queueAclProof('root');
      if (scope === 'leaf') return queueAclProof('leaf', {
        secure: false,
        no_reparse: false,
      });
      return codeTrustProof();
    });
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ACL');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(_testing.getWorkerSessionForTests().sessionId).not.toBe(failedSession.sessionId);
  });

  it.each([
    ['a missing required field', (proof: Record<string, unknown>) => { delete proof.allowed_sids; }],
    ['an unexpected extra field', (proof: Record<string, unknown>) => { proof.extra = true; }],
    ['the wrong proof scope', (proof: Record<string, unknown>) => { proof.scope = 'root'; }],
    ['a non-Administrators owner', (proof: Record<string, unknown>) => {
      proof.owner_sid = 'S-1-5-18';
    }],
    ['a different session path', (proof: Record<string, unknown>) => {
      proof.queue_dir = 'C:\\ProgramData\\PCDoctorWorkerQueue\\aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    }],
    ['a changed user SID', (proof: Record<string, unknown>) => {
      proof.user_sid = 'S-1-5-21-2000';
      proof.allowed_sids = ['S-1-5-21-2000', 'S-1-5-32-544', 'S-1-5-18'];
    }],
  ])('rejects a queue-leaf proof with %s', async (_label, mutate) => {
    execFileSyncMock.mockImplementation((...args: any[]) => {
      const options = args[2] as { env?: NodeJS.ProcessEnv } | undefined;
      const scope = options?.env?.PCDOCTOR_QUEUE_PROOF_SCOPE;
      if (scope === 'root') return queueAclProof('root');
      if (scope === 'leaf') return mutateQueueAclProof('leaf', mutate);
      return codeTrustProof();
    });
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_QUEUE_ACL');
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('allows CreateDirectories alone on an ancestor of the protected existing root', async () => {
    setHeartbeat({ ageMs: 1_000 });
    execFileSyncMock
      .mockReturnValueOnce(queueAclProof())
      .mockReturnValueOnce(codeTrustProof({ ancestor_untrusted_rights: 4 }));

    await expect(ensureWorkerRunning()).resolves.toBeUndefined();
    expect(_testing.isUnsafeAncestorAccessRule(4, 0)).toBe(false);
  });

  it('fails closed when a ProgramData ancestor grants untrusted DeleteChild', async () => {
    setHeartbeat({ ageMs: 1_000 });
    execFileSyncMock
      .mockReturnValueOnce(queueAclProof())
      .mockReturnValueOnce(codeTrustProof({
        ancestor_untrusted_rights: 64,
      }));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_CODE_TRUST');
    expect(_testing.isUnsafeAncestorAccessRule(64, 0)).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does not apply an InheritOnly DeleteChild ACE to its current ancestor node', () => {
    expect(_testing.isUnsafeAncestorAccessRule(64, 2)).toBe(false);
  });

  it('fails closed when an otherwise safe ancestor has an untrusted owner', async () => {
    setHeartbeat({ ageMs: 1_000 });
    execFileSyncMock
      .mockReturnValueOnce(queueAclProof())
      .mockReturnValueOnce(codeTrustProof({ trusted_ancestor_owner: false }));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_CODE_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it.each([
    ['worker path mismatch', { worker_script: 'C:\\Users\\attacker\\Elevated-Worker.ps1' }],
    ['reparse point', { no_reparse: false }],
    ['untrusted write access', { no_untrusted_write: false }],
    ['incomplete file proof', { checked_files: 9 }],
  ])('fails closed when the code trust proof reports %s', async (_label, overrides) => {
    setHeartbeat({ ageMs: 1_000 });
    execFileSyncMock
      .mockReturnValueOnce(queueAclProof())
      .mockReturnValueOnce(codeTrustProof(overrides));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_CODE_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('fails closed instead of launching when only the bundle fallback exists', async () => {
    const bundleRoot = 'C:\\Users\\someone\\App Data\\PCDoctor\\resources\\powershell';
    resolveScriptPathMock.mockImplementation((relative: string) => (
      `${bundleRoot}\\${relative.replace(/\//g, '\\')}`
    ));
    fakeFs.set(`${bundleRoot}\\worker\\Elevated-Worker.ps1`, '<bundle worker>');
    execFileSyncMock
      .mockReturnValueOnce(queueAclProof())
      .mockReturnValueOnce(codeTrustProof({ secure: false, checked_files: 0 }));

    const error = await ensureWorkerRunning().catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_CODE_TRUST');
    expect(spawnMock).not.toHaveBeenCalled();
    expect(resolveScriptPathMock).not.toHaveBeenCalled();
  });

  it('uses only fixed ProgramData coordinates after a successful trust proof', async () => {
    const bundleRoot = 'C:\\Users\\someone\\App Data\\PCDoctor\\resources\\powershell';
    resolveScriptPathMock.mockImplementation((relative: string) => (
      `${bundleRoot}\\${relative.replace(/\//g, '\\')}`
    ));
    setTimeout(() => setHeartbeat({ ageMs: 0 }), 350);

    await ensureWorkerRunning();

    const launchCommand = String(spawnMock.mock.calls[0][1]?.at(-1));
    expect(launchCommand).toContain('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1');
    expect(launchCommand).toContain('C:\\ProgramData\\PCDoctor');
    expect(launchCommand).not.toContain(bundleRoot);
    expect(resolveScriptPathMock).not.toHaveBeenCalled();
  });

  it('fails immediately and safely when the launcher emits an error', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    vi.useFakeTimers();
    try {
      const pending = ensureWorkerRunning().catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnChildren).toHaveLength(1);
      const observed = spawnChildren[0].emit('error', new Error('launcher unavailable'));
      await vi.advanceTimersByTimeAsync(_testing.WORKER_SPAWN_TIMEOUT_MS + 250);

      const error = await pending;
      expect(observed).toBe(true);
      expect(error).toBeInstanceOf(ElevatedWorkerError);
      expect(error.code).toBe('E_WORKER_LAUNCH');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on a premature nonzero launcher exit', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    vi.useFakeTimers();
    try {
      const pending = ensureWorkerRunning().catch((caught) => caught);
      await vi.advanceTimersByTimeAsync(0);
      expect(spawnChildren).toHaveLength(1);
      const observed = spawnChildren[0].emit('exit', 7, null);
      await vi.advanceTimersByTimeAsync(_testing.WORKER_SPAWN_TIMEOUT_MS + 250);

      const error = await pending;
      expect(observed).toBe(true);
      expect(error).toBeInstanceOf(ElevatedWorkerError);
      expect(error.code).toBe('E_WORKER_LAUNCH');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an authenticated heartbeat, not a zero launcher exit, as readiness', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    vi.useFakeTimers();
    try {
      const pending = ensureWorkerRunning();
      await vi.advanceTimersByTimeAsync(0);
      spawnChildren[0].emit('exit', 0, null);
      await vi.advanceTimersByTimeAsync(500);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      setHeartbeat({ ageMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the same session after one transient invalid heartbeat read', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    vi.useFakeTimers();
    try {
      const initialStart = ensureWorkerRunning();
      await vi.advanceTimersByTimeAsync(250);
      setHeartbeat({ ageMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await initialStart;
      const originalSession = _testing.getWorkerSessionForTests().sessionId;

      fakeFs.set(heartbeatPath(), '{partial');
      const healthCheck = ensureWorkerRunning();
      await vi.advanceTimersByTimeAsync(100);
      setHeartbeat({ ageMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await healthCheck;

      expect(_testing.getWorkerSessionForTests().sessionId).toBe(originalSession);
      expect(spawnMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
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
  beforeEach(resetBoundary);

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
        success: true,
        data: { before: { start_type: 'Automatic' }, after: { start_type: 'Disabled' } },
        duration_ms: 240,
      });
    }, 200);

    const result = await dispatchCommand('set-service-startup', {
      service: 'Spooler',
      startup_type: 'Disabled',
    });
    expect(result.success).toBe(true);
    expect((result.data as any).after.start_type).toBe('Disabled');

    // Both cmd and result files should be cleaned up.
    const remainingQueueFiles = Array.from(fakeFs.keys()).filter(
      (k) => k.endsWith('.cmd.json') || k.endsWith('.result.json'),
    );
    expect(remainingQueueFiles).toEqual([]);
    expect(renameSyncMock.mock.calls.some(([, destination]) => (
      String(destination).endsWith('.cmd.json')
    ))).toBe(true);
  });

  it('returns the success=false envelope when the worker reports an error', async () => {
    setHeartbeat({ ageMs: 1000 });
    setTimeout(() => {
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      const id = cmdFiles[0].match(/([a-f0-9]+)\.cmd\.json$/)?.[1];
      setResult(id!, {
        success: false,
        error: { code: 'E_SVC_NOT_FOUND', message: 'Service does not exist' },
        duration_ms: 30,
      });
    }, 200);

    const result = await dispatchCommand('set-service-startup', {
      service: 'Nonexistent',
      startup_type: 'Disabled',
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SVC_NOT_FOUND');
  });

  it('throws E_CMD_TIMEOUT and cleans up the cmd file when no result appears', async () => {
    setHeartbeat({ ageMs: 1000 });
    const err = await dispatchCommand('stop-service', { service: 'Spooler' }, { timeoutMs: 300 })
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

    const err = await dispatchCommand('start-service', { service: 'Spooler' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ElevatedWorkerError);
    expect(err.code).toBe('E_BAD_RESULT');
  });

  it('rejects a signed result artifact whose malformed UTF-8 replacement-decodes', async () => {
    setHeartbeat({ ageMs: 1_000 });
    setTimeout(() => {
      const cmdPath = Array.from(fakeFs.keys()).find((key) => key.endsWith('.cmd.json'))!;
      const id = JSON.parse(fakeFs.get(cmdPath)!).id;
      setResult(id, { success: true, data: { state: '\ufffd(' }, duration_ms: 1 });
      const resultPath = _testing.getResultPath(id);
      const valid = Buffer.from(fakeFs.get(resultPath)!, 'utf8');
      const replacementIndex = valid.indexOf(Buffer.from('\ufffd', 'utf8'));
      expect(replacementIndex).toBeGreaterThanOrEqual(0);
      fakeFs.delete(resultPath);
      fakeBytes.set(resultPath, Buffer.concat([
        valid.subarray(0, replacementIndex),
        Buffer.from([0xc3]),
        valid.subarray(replacementIndex + Buffer.byteLength('\ufffd', 'utf8')),
      ]));
    }, 100);

    const error = await dispatchCommand('stop-service', { service: 'Spooler' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_BAD_RESULT');
  });

  it('rejects a signed result artifact prefixed with a noncanonical UTF-8 BOM', async () => {
    setHeartbeat({ ageMs: 1_000 });
    setTimeout(() => {
      const cmdPath = Array.from(fakeFs.keys()).find((key) => key.endsWith('.cmd.json'))!;
      const id = JSON.parse(fakeFs.get(cmdPath)!).id;
      setResult(id, { success: true, data: { state: 'Stopped' }, duration_ms: 1 });
      const resultPath = _testing.getResultPath(id);
      const valid = Buffer.from(fakeFs.get(resultPath)!, 'utf8');
      fakeFs.delete(resultPath);
      fakeBytes.set(resultPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid]));
    }, 100);

    const error = await dispatchCommand('stop-service', { service: 'Spooler' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_BAD_RESULT');
  });

  it('rejects an oversized result before the legacy unbounded read', async () => {
    setHeartbeat({ ageMs: 1_000 });
    let oversizedPath = '';
    setTimeout(() => {
      const cmdPath = Array.from(fakeFs.keys()).find((key) => key.endsWith('.cmd.json'))!;
      const id = JSON.parse(fakeFs.get(cmdPath)!).id;
      oversizedPath = _testing.getResultPath(id);
      fakeFs.set(oversizedPath, 'x'.repeat(WORKER_ARTIFACT_MAX_BYTES + 1));
    }, 100);

    const error = await dispatchCommand('stop-service', { service: 'Spooler' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_BAD_RESULT');
    expect(readFileSyncMock.mock.calls.some(([file]) => String(file) === oversizedPath)).toBe(false);
  });

  it.each([
    ['forged HMAC', (id: string) => {
      setResult(id, { success: true, data: { state: 'forged' }, duration_ms: 1 });
      const resultPath = _testing.getResultPath(id);
      const result = JSON.parse(fakeFs.get(resultPath)!);
      result.hmac_sha256 = '0'.repeat(64);
      fakeFs.set(resultPath, JSON.stringify(result));
    }],
    ['tampered data', (id: string) => {
      setResult(id, { success: true, data: { state: 'trusted' }, duration_ms: 1 });
      const resultPath = _testing.getResultPath(id);
      const result = JSON.parse(fakeFs.get(resultPath)!);
      result.data.state = 'tampered';
      fakeFs.set(resultPath, JSON.stringify(result));
    }],
    ['wrong session', (id: string) => {
      setResult(id, { success: true, data: {}, duration_ms: 1 }, {
        session_id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
    }],
    ['stale issued_at', (id: string) => {
      setResult(id, { success: true, data: {}, duration_ms: 1 }, {
        issued_at: Date.now() - 30_001,
      });
    }],
    ['wrong action', (id: string) => {
      setResult(id, { success: true, data: {}, duration_ms: 1 }, { action: 'start-service' });
    }],
  ])('rejects an authenticated-result boundary violation: %s', async (_label, writeResult) => {
    setHeartbeat({ ageMs: 1_000 });
    setTimeout(() => {
      const cmdPath = Array.from(fakeFs.keys()).find((key) => key.endsWith('.cmd.json'))!;
      const id = JSON.parse(fakeFs.get(cmdPath)!).id;
      writeResult(id);
    }, 100);

    const error = await dispatchCommand('stop-service', { service: 'Spooler' })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_BAD_RESULT');
  });

  it('writes an exact authenticated V2 envelope without the capability', async () => {
    setHeartbeat({ ageMs: 1000 });
    let writtenPayload: any = null;
    setTimeout(() => {
      const cmdFiles = Array.from(fakeFs.keys()).filter((k) => k.endsWith('.cmd.json'));
      writtenPayload = JSON.parse(fakeFs.get(cmdFiles[0])!);
      const id = writtenPayload.id;
      setResult(id, { success: true, data: {}, duration_ms: 1 });
    }, 100);

    await dispatchCommand('kill-process', { target: '5678' });
    expect(Object.keys(writtenPayload).sort()).toEqual([
      'action',
      'expires_at',
      'hmac_sha256',
      'id',
      'issued_at',
      'nonce',
      'params',
      'session_id',
      'version',
    ]);
    expect(writtenPayload.version).toBe(2);
    expect(writtenPayload.action).toBe('kill-process');
    expect(writtenPayload.params).toEqual({ target: '5678' });
    expect(writtenPayload.id).toMatch(/^[a-f0-9]{32}$/);
    expect(writtenPayload.nonce).toMatch(/^[a-f0-9]{32}$/);
    expect(writtenPayload.session_id).toMatch(/^[a-f0-9]{32}$/);
    expect(writtenPayload.hmac_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(writtenPayload.expires_at - writtenPayload.issued_at).toBeLessThanOrEqual(30_000);
    const capability = _testing.getWorkerSessionForTests().capability.toString('base64');
    expect(JSON.stringify(writtenPayload)).not.toContain(capability);
  });

  it('snapshots params before UAC but signs only after the worker heartbeat', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    const params = { service: 'Spooler' };
    let heartbeatSeenAt = 0;
    let writtenPayload: Record<string, any> | null = null;

    setTimeout(() => {
      params.service = 'BITS';
      heartbeatSeenAt = Date.now();
      setHeartbeat({ ageMs: 0 });
    }, 300);
    const responsePoll = setInterval(() => {
      const cmdPath = Array.from(fakeFs.keys()).find((key) => key.endsWith('.cmd.json'));
      if (!cmdPath) return;
      writtenPayload = JSON.parse(fakeFs.get(cmdPath)!);
      setResult(writtenPayload!.id, {
        success: true,
        data: {},
        duration_ms: 1,
      });
      clearInterval(responsePoll);
    }, 20);

    await dispatchCommand('stop-service', params);

    expect(writtenPayload).not.toBeNull();
    expect(writtenPayload!.params).toEqual({ service: 'Spooler' });
    expect(writtenPayload!.issued_at).toBeGreaterThanOrEqual(heartbeatSeenAt);
  });

  it('keeps a retired session capability valid until its in-flight dispatch finishes', async () => {
    fakeFs.set('C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1', '<script>');
    vi.useFakeTimers();
    try {
      const initialStart = ensureWorkerRunning();
      await vi.advanceTimersByTimeAsync(250);
      setHeartbeat({ ageMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await initialStart;
      const oldSession = _testing.getWorkerSessionForTests();

      const pendingDispatch = dispatchCommand('stop-service', { service: 'Spooler' });
      await vi.advanceTimersByTimeAsync(0);
      const oldCommandPath = Array.from(fakeFs.keys()).find((candidate) => (
        candidate.startsWith(oldSession.queueDir) && candidate.endsWith('.cmd.json')
      ));
      expect(oldCommandPath).toBeDefined();
      const oldCommand = JSON.parse(fakeFs.get(oldCommandPath!)!);

      fakeFs.set(`${oldSession.queueDir}\\.heartbeat`, '{partial');
      const replacementStart = ensureWorkerRunning();
      await vi.advanceTimersByTimeAsync(300);
      expect(_testing.getWorkerSessionForTests().sessionId).not.toBe(oldSession.sessionId);
      setHeartbeat({ ageMs: 0 });
      await vi.advanceTimersByTimeAsync(250);
      await replacementStart;

      const oldResult = signResultFields({
        version: 2,
        session_id: oldSession.sessionId,
        id: oldCommand.id,
        action: 'stop-service',
        success: true,
        data: { state: 'Stopped' },
        duration_ms: 12,
        issued_at: Date.now(),
        nonce: 'abababababababababababababababab',
      }, oldSession.capability);
      fakeFs.set(
        `${oldSession.queueDir}\\${oldCommand.id}.result.json`,
        JSON.stringify(oldResult),
      );
      await vi.advanceTimersByTimeAsync(100);

      await expect(pendingDispatch).resolves.toEqual({
        id: oldCommand.id,
        duration_ms: 12,
        success: true,
        data: { state: 'Stopped' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['unknown parameter', 'stop-service', { service: 'Spooler', executable: 'cmd.exe' }],
    ['missing required parameter', 'stop-service', {}],
    ['wrong parameter type', 'stop-service', { service: 42 }],
    ['service wildcard', 'stop-service', { service: '*' }],
    ['service path', 'stop-service', { service: 'bad/name' }],
    ['process wildcard', 'kill-process', { target: '?' }],
    ['process whitespace', 'kill-process', { target: 'bad target' }],
  ])('rejects %s before writing a command', async (_label, action, params) => {
    setHeartbeat({ ageMs: 1_000 });
    const error = await dispatchCommand(action as any, params).catch((caught) => caught);
    expect(error).toBeInstanceOf(ElevatedWorkerError);
    expect(error.code).toBe('E_INVALID_PARAMS');
    expect(Array.from(fakeFs.keys()).some((key) => key.endsWith('.cmd.json'))).toBe(false);
    expect(spawnMock).not.toHaveBeenCalled();
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

describe('elevatedWorker > buildLaunchCmd', () => {
  const opts = {
    pwsh: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    workerScript: 'C:\\ProgramData\\PCDoctor\\worker\\Elevated-Worker.ps1',
    basePath: 'C:\\ProgramData\\PCDoctor',
    queueRoot: 'C:\\ProgramData\\PCDoctorWorkerQueue',
    sessionId: '00112233445566778899aabbccddeeff',
    queueUserSid: 'S-1-5-21-1000',
  };

  it('passes one prequoted native ArgumentList string that preserves spaces and apostrophes', () => {
    const cmd = buildLaunchCmd({
      ...opts,
      queueRoot: "C:\\ProgramData\\O'Brien Queue Root\\",
    });
    const matches = Array.from(cmd.matchAll(/-ArgumentList\s+('(?:[^']|'')*')/g));

    expect(matches).toHaveLength(1);
    expect(cmd).not.toContain('-ArgumentList @(');
    expect(matches[0][1]).toContain('"-NoProfile" "-ExecutionPolicy" "Bypass"');
    expect(matches[0][1]).toContain("\"C:\\ProgramData\\O''Brien Queue Root\\\\\"");
  });

  it('preserves all required worker args in order', () => {
    const cmd = buildLaunchCmd(opts);
    // Sanity-check the worker receives only non-secret launch coordinates.
    expect(cmd).toContain('"-File"');
    expect(cmd).toContain('"-BasePath"');
    expect(cmd).toContain('"-QueueRoot"');
    expect(cmd).not.toContain('"-QueueDir"');
    expect(cmd).toContain('"-SessionId"');
    expect(cmd).toContain('"-QueueUserSid"');
    expect(cmd).toContain(`"${opts.workerScript}"`);
    expect(cmd).toContain(`"${opts.basePath}"`);
    expect(cmd).toContain(`"${opts.queueRoot}"`);
    expect(cmd).toContain(`"${opts.sessionId}"`);
    expect(cmd).toContain(`"${opts.queueUserSid}"`);
    expect(cmd).toContain(`Remove-Item Env:\\${_testing.CAPABILITY_ENV}`);
  });

  it('keeps capability material outside the native argument string', () => {
    const capability = Buffer.alloc(32, 0xa5).toString('base64');
    const cmd = buildLaunchCmd(opts);
    expect(cmd).not.toContain(capability);
  });
});
