/**
 * Module: elevatedWorkerProtocol.ts
 * Purpose: Define, sign, and validate the authenticated elevated-worker protocol.
 * Dependencies: Node crypto for HMAC and node:util for proxy-safe snapshots.
 * Used by: elevatedWorker orchestration and focused protocol tests.
 * Key decisions: This module is side-effect free: it never touches files, processes,
 * elevation, global environment, or persistent state. Replay state is caller-owned.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { types as nodeTypes } from 'node:util';

export const WORKER_ACTIONS = [
  'set-service-startup',
  'stop-service',
  'start-service',
  'restart-service',
  'kill-process',
  'set-process-priority',
  'set-process-affinity',
  'suspend-process',
  'resume-process',
] as const;

export type WorkerAction = (typeof WORKER_ACTIONS)[number];
export type JsonPrimitive = null | boolean | number | string;
export interface JsonObject { readonly [key: string]: JsonValue }
export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export type ParamRule = Readonly<{
  type: 'string' | 'integer' | 'boolean';
  nonEmpty?: boolean;
  min?: number;
  max?: number;
  values?: readonly string[];
}>;

export interface WorkerActionContract {
  automation: 'never' | 'safe' | 'conditional';
  rebootPolicy: 'never' | 'restart';
  manualAllowed: boolean;
  required: Readonly<Record<string, ParamRule>>;
  optional: Readonly<Record<string, ParamRule>>;
}

export type WorkerActionContracts = Readonly<Record<string, WorkerActionContract>>;

const stringRule = (values?: readonly string[]): ParamRule => Object.freeze({
  type: 'string',
  nonEmpty: true,
  ...(values ? { values: Object.freeze([...values]) } : {}),
});
const integerRule = (min: number, max: number): ParamRule => Object.freeze({
  type: 'integer', min, max,
});
const booleanRule: ParamRule = Object.freeze({ type: 'boolean' });
const dryRunOptional = Object.freeze({ dry_run: booleanRule });
const manualContract = (
  required: Readonly<Record<string, ParamRule>>,
): WorkerActionContract => Object.freeze({
  automation: 'never',
  rebootPolicy: 'never',
  manualAllowed: true,
  required: Object.freeze(required),
  optional: dryRunOptional,
});

export const WORKER_ACTION_CONTRACTS: WorkerActionContracts = Object.freeze({
  'set-service-startup': manualContract({
    service: stringRule(),
    startup_type: stringRule(['Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled']),
  }),
  'stop-service': manualContract({ service: stringRule() }),
  'start-service': manualContract({ service: stringRule() }),
  'restart-service': manualContract({ service: stringRule() }),
  'kill-process': manualContract({ target: stringRule() }),
  'set-process-priority': manualContract({
    target: integerRule(1, 2_147_483_647),
    class: stringRule(['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'RealTime']),
  }),
  'set-process-affinity': manualContract({
    target: integerRule(1, 2_147_483_647),
    mask: integerRule(1, Number.MAX_SAFE_INTEGER),
  }),
  'suspend-process': manualContract({ target: integerRule(1, 2_147_483_647) }),
  'resume-process': manualContract({ target: integerRule(1, 2_147_483_647) }),
});

export const WORKER_ENVELOPE_MAX_LIFETIME_MS = 30_000;
export const WORKER_CAPABILITY_BYTES = 32;
const ENVELOPE_VERSION = 2 as const;
const ENVELOPE_FUTURE_SKEW_MS = 5_000;
const ARTIFACT_MAX_AGE_MS = 30_000;
export const WORKER_ARTIFACT_MAX_BYTES = 1_048_576;
const RESULT_DATA_MAX_BYTES = 524_288;
const REBOOT_ACTION_PATTERN = /^(?:reboot|shutdown|restart-computer|shutdown-computer)$/i;
const HEX_128_PATTERN = /^[0-9a-f]{32}$/;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;
const ENVELOPE_BASE_KEYS = [
  'version', 'session_id', 'id', 'action', 'params', 'issued_at', 'expires_at',
  'nonce', 'hmac_sha256',
] as const;
const ENVELOPE_AUTOMATIC_KEYS = ['policy_id', 'intent_id'] as const;
const UNSIGNED_BASE_KEYS = ENVELOPE_BASE_KEYS.filter((key) => key !== 'hmac_sha256');
const HEARTBEAT_KEYS = [
  'version', 'session_id', 'worker_pid', 'issued_at', 'expires_at', 'nonce', 'hmac_sha256',
] as const;
const UNSIGNED_HEARTBEAT_KEYS = HEARTBEAT_KEYS.filter((key) => key !== 'hmac_sha256');
const RESULT_BASE_KEYS = [
  'version', 'session_id', 'id', 'action', 'success', 'duration_ms', 'issued_at',
  'nonce', 'hmac_sha256',
] as const;
const UNSIGNED_RESULT_BASE_KEYS = RESULT_BASE_KEYS.filter((key) => key !== 'hmac_sha256');

export interface WorkerCommandEnvelopeV2 {
  readonly version: 2;
  readonly session_id: string;
  readonly id: string;
  readonly action: string;
  readonly params: Readonly<Record<string, JsonValue>>;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly nonce: string;
  readonly policy_id?: string;
  readonly intent_id?: string;
  readonly hmac_sha256: string;
}

export interface WorkerHeartbeatEnvelopeV2 {
  readonly version: 2;
  readonly session_id: string;
  readonly worker_pid: number;
  readonly issued_at: number;
  readonly expires_at: number;
  readonly nonce: string;
  readonly hmac_sha256: string;
}

export interface WorkerResultEnvelopeV2 {
  readonly version: 2;
  readonly session_id: string;
  readonly id: string;
  readonly action: string;
  readonly success: boolean;
  readonly duration_ms: number;
  readonly data?: JsonValue;
  readonly error?: Readonly<{ code: string; message: string }>;
  readonly issued_at: number;
  readonly nonce: string;
  readonly hmac_sha256: string;
}

export interface EnvelopeValidationContext {
  capability: Buffer;
  sessionId: string;
  now: number;
  acceptedNonces: Set<string>;
  contracts?: WorkerActionContracts;
}

export interface ArtifactValidationContext {
  capability: Buffer;
  sessionId: string;
  now: number;
}

export interface ResultValidationContext extends ArtifactValidationContext {
  commandId: string;
  action: string;
  acceptedNonces: Set<string>;
}

export class ElevatedWorkerError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ElevatedWorkerError';
  }
}

function fail(code: string, message: string): never {
  throw new ElevatedWorkerError(code, message);
}

/** Rejects lone UTF-16 surrogates so UTF-8 HMAC input matches PowerShell. */
function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) fail('E_BAD_JSON', 'Lone high surrogate');
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail('E_BAD_JSON', 'Lone low surrogate');
    }
  }
}

/** Copies only unambiguous JSON data without invoking accessors, then freezes it. */
function snapshotJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertValidUnicode(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail('E_BAD_JSON', 'Canonical numbers must be safe integers other than negative zero');
    }
    return value;
  }
  if (typeof value !== 'object') fail('E_BAD_JSON', `Unsupported type: ${typeof value}`);

  try {
    if (nodeTypes.isProxy(value)) fail('E_BAD_JSON', 'Proxy values are forbidden');
    if (ancestors.has(value)) fail('E_BAD_JSON', 'Cyclic values are forbidden');
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);

    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) fail('E_BAD_JSON', 'Array subclass');
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1) {
        fail('E_BAD_JSON', 'Sparse or extended array');
      }
      const copy: JsonValue[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
          fail('E_BAD_JSON', 'Array entry is not an own data property');
        }
        copy.push(snapshotJsonValue(descriptor.value, nextAncestors));
      }
      return Object.freeze(copy);
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('E_BAD_JSON', 'Non-plain object');
    if (ownKeys.some((key) => typeof key !== 'string')) fail('E_BAD_JSON', 'Symbol key');
    const copy = Object.create(null) as Record<string, JsonValue>;
    for (const key of (ownKeys as string[]).sort()) {
      assertValidUnicode(key);
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') || !descriptor.enumerable) {
        fail('E_BAD_JSON', 'Object entry is not an enumerable own data property');
      }
      copy[key] = snapshotJsonValue(descriptor.value, nextAncestors);
    }
    return Object.freeze(copy);
  } catch (error) {
    if (error instanceof ElevatedWorkerError) throw error;
    fail('E_BAD_JSON', error instanceof Error ? error.message : 'JSON snapshot failed');
  }
}

function serializeCanonical(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.keys(object).sort().map((key) => (
    `${JSON.stringify(key)}:${serializeCanonical(object[key])}`
  )).join(',')}}`;
}

export function canonicalizeJson(value: unknown): string {
  return serializeCanonical(snapshotJsonValue(value));
}

function asJsonObject(
  value: JsonValue,
  code = 'E_BAD_ENVELOPE',
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(code, 'Expected a JSON object');
  }
  return value as JsonObject;
}

function hasExactKeys(
  value: Readonly<Record<string, JsonValue>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key));
}

function assertCapability(capability: Buffer): void {
  if (!Buffer.isBuffer(capability) || capability.length !== WORKER_CAPABILITY_BYTES) {
    fail('E_BAD_CAPABILITY', 'Worker capability must contain exactly 32 bytes');
  }
}

function signExactFields(
  unsignedInput: unknown,
  capability: Buffer,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, JsonValue>> {
  assertCapability(capability);
  const unsigned = asJsonObject(snapshotJsonValue(unsignedInput));
  if (!hasExactKeys(unsigned, required, optional)) {
    fail('E_BAD_ENVELOPE', 'Unsigned worker envelope has an invalid shape');
  }
  const hmac = createHmac('sha256', capability)
    .update(serializeCanonical(unsigned), 'utf8')
    .digest('hex');
  const signed = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(unsigned)) signed[key] = unsigned[key];
  signed.hmac_sha256 = hmac;
  return Object.freeze(signed);
}

function verifyRecordHmac(
  record: Readonly<Record<string, JsonValue>>,
  capability: Buffer,
): void {
  assertCapability(capability);
  if (typeof record.hmac_sha256 !== 'string' || !HMAC_PATTERN.test(record.hmac_sha256)) {
    fail('E_BAD_HMAC', 'Artifact HMAC format is invalid');
  }
  const unsigned = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(record)) if (key !== 'hmac_sha256') unsigned[key] = record[key];
  const expected = createHmac('sha256', capability)
    .update(serializeCanonical(unsigned), 'utf8')
    .digest();
  const supplied = Buffer.from(record.hmac_sha256, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('E_BAD_HMAC', 'Artifact authentication failed');
  }
}

export function signEnvelopeFields(unsignedInput: unknown, capability: Buffer): WorkerCommandEnvelopeV2 {
  const unsigned = asJsonObject(snapshotJsonValue(unsignedInput));
  const hasPolicy = Object.prototype.hasOwnProperty.call(unsigned, 'policy_id');
  const hasIntent = Object.prototype.hasOwnProperty.call(unsigned, 'intent_id');
  if (hasPolicy !== hasIntent) fail('E_BAD_ENVELOPE', 'Automatic fields must appear together');
  return signExactFields(
    unsigned,
    capability,
    UNSIGNED_BASE_KEYS,
    ENVELOPE_AUTOMATIC_KEYS,
  ) as unknown as WorkerCommandEnvelopeV2;
}

export function signHeartbeatFields(
  unsignedInput: unknown,
  capability: Buffer,
): WorkerHeartbeatEnvelopeV2 {
  return signExactFields(
    unsignedInput,
    capability,
    UNSIGNED_HEARTBEAT_KEYS,
  ) as unknown as WorkerHeartbeatEnvelopeV2;
}

export function signResultFields(
  unsignedInput: unknown,
  capability: Buffer,
): WorkerResultEnvelopeV2 {
  return signExactFields(
    unsignedInput,
    capability,
    UNSIGNED_RESULT_BASE_KEYS,
    ['data', 'error'],
  ) as unknown as WorkerResultEnvelopeV2;
}

function isRuleMatch(value: JsonValue, rule: ParamRule): boolean {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'integer') {
    return typeof value === 'number'
      && Number.isSafeInteger(value)
      && value >= (rule.min ?? Number.MIN_SAFE_INTEGER)
      && value <= (rule.max ?? Number.MAX_SAFE_INTEGER);
  }
  return typeof value === 'string'
    && (!rule.nonEmpty || value.trim().length > 0)
    && (!rule.values || rule.values.includes(value));
}

function validateParams(
  params: JsonValue,
  contract: WorkerActionContract,
): Readonly<Record<string, JsonValue>> {
  const object = asJsonObject(params, 'E_INVALID_PARAMS');
  if (!hasExactKeys(object, Object.keys(contract.required), Object.keys(contract.optional))) {
    fail('E_INVALID_PARAMS', 'Action parameters have missing or unknown properties');
  }
  for (const [key, rule] of Object.entries(contract.required)) {
    if (!isRuleMatch(object[key], rule)) fail('E_INVALID_PARAMS', `Invalid parameter: ${key}`);
  }
  for (const [key, rule] of Object.entries(contract.optional)) {
    if (Object.prototype.hasOwnProperty.call(object, key) && !isRuleMatch(object[key], rule)) {
      fail('E_INVALID_PARAMS', `Invalid parameter: ${key}`);
    }
  }
  return object;
}

function getActionContract(
  contracts: WorkerActionContracts,
  action: string,
): WorkerActionContract {
  if (!Object.prototype.hasOwnProperty.call(contracts, action)) {
    fail('E_INVALID_ACTION', `Unknown worker action: ${action}`);
  }
  const contract = contracts[action];
  if (!contract || typeof contract !== 'object') {
    fail('E_INVALID_ACTION', `Unknown worker action: ${action}`);
  }
  return contract;
}

function snapshotArtifact(
  input: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: string,
): Readonly<Record<string, JsonValue>> {
  try {
    const artifact = asJsonObject(snapshotJsonValue(input), code);
    if (!hasExactKeys(artifact, required, optional)) fail(code, 'Artifact shape is invalid');
    return artifact;
  } catch (error) {
    if (error instanceof ElevatedWorkerError && error.code !== code) fail(code, error.message);
    throw error;
  }
}

export function validateHeartbeat(
  input: unknown,
  context: ArtifactValidationContext,
): WorkerHeartbeatEnvelopeV2 {
  const heartbeat = snapshotArtifact(input, HEARTBEAT_KEYS, [], 'E_BAD_HEARTBEAT');
  if (heartbeat.version !== ENVELOPE_VERSION
    || typeof heartbeat.session_id !== 'string'
    || typeof heartbeat.worker_pid !== 'number' || !Number.isSafeInteger(heartbeat.worker_pid)
    || heartbeat.worker_pid <= 0
    || typeof heartbeat.issued_at !== 'number'
    || typeof heartbeat.expires_at !== 'number'
    || typeof heartbeat.nonce !== 'string' || !HEX_128_PATTERN.test(heartbeat.nonce)) {
    fail('E_BAD_HEARTBEAT', 'Heartbeat field type or format is invalid');
  }
  if (heartbeat.session_id !== context.sessionId) fail('E_WRONG_SESSION', 'Wrong heartbeat session');
  if (!Number.isSafeInteger(context.now)) fail('E_BAD_HEARTBEAT', 'Heartbeat time is invalid');
  if (heartbeat.expires_at <= context.now) fail('E_HEARTBEAT_EXPIRED', 'Heartbeat expired');
  if (heartbeat.issued_at > context.now + ENVELOPE_FUTURE_SKEW_MS) {
    fail('E_HEARTBEAT_FUTURE', 'Heartbeat issued too far in the future');
  }
  const lifetime = heartbeat.expires_at - heartbeat.issued_at;
  if (lifetime <= 0 || lifetime > ARTIFACT_MAX_AGE_MS) {
    fail('E_BAD_HEARTBEAT', 'Heartbeat lifetime exceeds 30 seconds');
  }
  verifyRecordHmac(heartbeat, context.capability);
  return heartbeat as unknown as WorkerHeartbeatEnvelopeV2;
}

export function validateResultEnvelope(
  input: unknown,
  context: ResultValidationContext,
): WorkerResultEnvelopeV2 {
  const result = snapshotArtifact(input, RESULT_BASE_KEYS, ['data', 'error'], 'E_BAD_RESULT');
  const hasData = Object.prototype.hasOwnProperty.call(result, 'data');
  const hasError = Object.prototype.hasOwnProperty.call(result, 'error');
  if (result.version !== ENVELOPE_VERSION
    || typeof result.session_id !== 'string'
    || typeof result.id !== 'string' || !HEX_128_PATTERN.test(result.id)
    || typeof result.action !== 'string'
    || typeof result.success !== 'boolean'
    || typeof result.duration_ms !== 'number' || !Number.isSafeInteger(result.duration_ms)
    || result.duration_ms < 0 || result.duration_ms > 86_400_000
    || typeof result.issued_at !== 'number' || !Number.isSafeInteger(result.issued_at)
    || typeof result.nonce !== 'string' || !HEX_128_PATTERN.test(result.nonce)
    || (result.success && (!hasData || hasError))
    || (!result.success && (hasData || !hasError))) {
    fail('E_BAD_RESULT', 'Result field type, format, or union is invalid');
  }
  if (result.session_id !== context.sessionId) fail('E_WRONG_SESSION', 'Wrong result session');
  if (result.id !== context.commandId) fail('E_BAD_RESULT', 'Result command ID mismatch');
  if (result.action !== context.action) fail('E_BAD_RESULT', 'Result action mismatch');
  if (!Number.isSafeInteger(context.now)) fail('E_BAD_RESULT', 'Result time is invalid');
  if (result.issued_at < context.now - ARTIFACT_MAX_AGE_MS) fail('E_RESULT_STALE', 'Result is stale');
  if (result.issued_at > context.now + ENVELOPE_FUTURE_SKEW_MS) fail('E_RESULT_FUTURE', 'Result is future dated');
  verifyRecordHmac(result, context.capability);

  if (result.success) {
    if (Buffer.byteLength(serializeCanonical(result.data as JsonValue), 'utf8') > RESULT_DATA_MAX_BYTES) {
      fail('E_BAD_RESULT', 'Result data exceeds the bounded payload size');
    }
  } else {
    const error = asJsonObject(result.error as JsonValue, 'E_BAD_RESULT');
    if (!hasExactKeys(error, ['code', 'message'])
      || typeof error.code !== 'string' || error.code.length < 1 || error.code.length > 256
      || typeof error.message !== 'string' || error.message.length > 4_096) {
      fail('E_BAD_RESULT', 'Result error payload is invalid');
    }
  }

  if (!(context.acceptedNonces instanceof Set)) fail('E_BAD_RESULT', 'Result replay state unavailable');
  if (context.acceptedNonces.has(result.nonce)) fail('E_REPLAY', 'Result nonce already accepted');
  context.acceptedNonces.add(result.nonce);
  return result as unknown as WorkerResultEnvelopeV2;
}

/**
 * Validates an envelope and records its nonce only after every other check.
 * The caller owns nonce storage for exactly one worker process lifetime.
 */
export function validateEnvelope(
  envelopeInput: unknown,
  contextInput: EnvelopeValidationContext | Record<string, unknown>,
): WorkerCommandEnvelopeV2 {
  let envelope: Readonly<Record<string, JsonValue>>;
  try {
    envelope = asJsonObject(snapshotJsonValue(envelopeInput));
  } catch (error) {
    if (error instanceof ElevatedWorkerError) fail('E_BAD_ENVELOPE', error.message);
    throw error;
  }
  if (!hasExactKeys(envelope, ENVELOPE_BASE_KEYS, ENVELOPE_AUTOMATIC_KEYS)) {
    fail('E_BAD_ENVELOPE', 'Worker envelope has missing or extra properties');
  }
  const hasPolicy = Object.prototype.hasOwnProperty.call(envelope, 'policy_id');
  const hasIntent = Object.prototype.hasOwnProperty.call(envelope, 'intent_id');
  if (hasPolicy !== hasIntent) {
    fail('E_AUTOMATIC_CAPABILITY_REQUIRED', 'Policy and intent IDs must appear together');
  }
  if (envelope.version !== ENVELOPE_VERSION
    || typeof envelope.session_id !== 'string'
    || typeof envelope.id !== 'string' || !HEX_128_PATTERN.test(envelope.id)
    || typeof envelope.action !== 'string'
    || typeof envelope.nonce !== 'string' || !HEX_128_PATTERN.test(envelope.nonce)
    || typeof envelope.issued_at !== 'number'
    || typeof envelope.expires_at !== 'number'
    || typeof envelope.hmac_sha256 !== 'string' || !HMAC_PATTERN.test(envelope.hmac_sha256)) {
    fail('E_BAD_ENVELOPE', 'Worker envelope fields have invalid types or formats');
  }

  const context = contextInput as EnvelopeValidationContext;
  if (!Buffer.isBuffer(context.capability) || context.capability.length !== WORKER_CAPABILITY_BYTES) {
    fail('E_BAD_CAPABILITY', 'Validation capability must contain exactly 32 bytes');
  }
  if (envelope.session_id !== context.sessionId) fail('E_WRONG_SESSION', 'Wrong worker session');
  if (!Number.isSafeInteger(context.now)) fail('E_BAD_ENVELOPE', 'Validation time is invalid');
  if (envelope.expires_at <= context.now) fail('E_ENVELOPE_EXPIRED', 'Envelope expired');
  if (envelope.issued_at > context.now + ENVELOPE_FUTURE_SKEW_MS) {
    fail('E_ENVELOPE_FUTURE', 'Envelope issued too far in the future');
  }
  const lifetime = envelope.expires_at - envelope.issued_at;
  if (lifetime <= 0 || lifetime > WORKER_ENVELOPE_MAX_LIFETIME_MS) {
    fail('E_ENVELOPE_LIFETIME', 'Envelope lifetime exceeds 30 seconds');
  }

  const unsigned = Object.create(null) as Record<string, JsonValue>;
  for (const key of Object.keys(envelope)) if (key !== 'hmac_sha256') unsigned[key] = envelope[key];
  const expected = createHmac('sha256', context.capability)
    .update(serializeCanonical(unsigned), 'utf8')
    .digest();
  const supplied = Buffer.from(envelope.hmac_sha256, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    fail('E_BAD_HMAC', 'Envelope authentication failed');
  }

  if (REBOOT_ACTION_PATTERN.test(envelope.action)) {
    fail('E_REBOOT_FORBIDDEN', 'Reboot and shutdown actions are forbidden');
  }
  const contract = getActionContract(context.contracts ?? WORKER_ACTION_CONTRACTS, envelope.action);
  if (hasPolicy && hasIntent) {
    if (typeof envelope.policy_id !== 'string' || envelope.policy_id.trim().length === 0
      || typeof envelope.intent_id !== 'string' || envelope.intent_id.trim().length === 0) {
      fail('E_AUTOMATIC_CAPABILITY_REQUIRED', 'Automatic identifiers must be non-empty');
    }
    if (contract.rebootPolicy !== 'never') fail('E_REBOOT_FORBIDDEN', 'Automatic reboot forbidden');
    if (contract.automation === 'never') fail('E_AUTOMATION_NEVER', 'Action is never automatic');
  } else if (!contract.manualAllowed) {
    fail('E_AUTOMATIC_CAPABILITY_REQUIRED', 'Action requires automatic capability');
  }

  validateParams(envelope.params, contract);
  if (!(context.acceptedNonces instanceof Set)) fail('E_BAD_ENVELOPE', 'Replay state unavailable');
  if (context.acceptedNonces.has(envelope.nonce)) fail('E_REPLAY', 'Nonce already accepted');
  context.acceptedNonces.add(envelope.nonce);
  return envelope as unknown as WorkerCommandEnvelopeV2;
}

export function createManualWorkerEnvelope(input: {
  sessionId: string;
  capability: Buffer;
  action: WorkerAction;
  params: Readonly<Record<string, unknown>>;
  issuedAt: number;
  id: string;
  nonce: string;
}): WorkerCommandEnvelopeV2 {
  const validatedParams = snapshotWorkerActionParams(input.action, input.params);
  return signEnvelopeFields({
    version: ENVELOPE_VERSION,
    session_id: input.sessionId,
    id: input.id,
    action: input.action,
    params: validatedParams,
    issued_at: input.issuedAt,
    expires_at: input.issuedAt + WORKER_ENVELOPE_MAX_LIFETIME_MS,
    nonce: input.nonce,
  }, input.capability);
}

/** Copies and validates manual action params before any caller-side UAC wait. */
export function snapshotWorkerActionParams(
  action: WorkerAction,
  paramsInput: Readonly<Record<string, unknown>>,
): Readonly<Record<string, JsonValue>> {
  const contract = getActionContract(WORKER_ACTION_CONTRACTS, action);
  let params: JsonValue;
  try {
    params = snapshotJsonValue(paramsInput);
  } catch (error) {
    fail('E_INVALID_PARAMS', error instanceof Error ? error.message : 'Invalid action parameters');
  }
  return validateParams(params, contract);
}
