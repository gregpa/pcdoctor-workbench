/**
 * Module: automationPolicy.ts
 * Purpose: Evaluate automatic maintenance eligibility without side effects.
 * Dependencies: Shared policy input and decision contracts only.
 * Used by: Future automatic execution boundaries and focused policy tests.
 * Key decisions: Checks are ordered from trust boundaries to action proofs and return the first denial.
 */

import { types as nodeTypes } from 'node:util';
import type {
  AutomationPolicyInput,
  PolicyDecision,
  TrustedExecutionContext,
} from '../shared/automation.js';

const INPUT_KEYS = [
  'context',
  'globalEnabled',
  'automation',
  'rebootPolicy',
  'requiresRollback',
  'resourceLocks',
  'preflightId',
  'postconditionId',
  'cooldownMs',
  'maxAttempts',
  'confirmLevel',
  'rebootRequired',
  'policy',
  'evidence',
  'gates',
  'now',
] as const;
const CONTEXT_KEYS = ['mode', 'source', 'intentId', 'policyId'] as const;
const POLICY_KEYS = ['enabled', 'snoozedUntil'] as const;
const EVIDENCE_KEYS = ['state'] as const;
const GATE_KEYS = [
  'maintenanceWindowOpen',
  'loadAllowed',
  'idleSatisfied',
  'locksAvailable',
  'cooldownElapsed',
  'attemptsRemaining',
  'preflightPassed',
  'rollbackReady',
] as const;

type PlainRecord = Record<string, unknown>;

interface RuntimePolicyState {
  enabled: unknown;
  snoozedUntil: number | null;
}

interface RuntimeEvidence {
  state: 'fresh' | 'stale';
}

/**
 * Copies allowlisted own data properties into an immutable null-prototype record.
 * Reflection and proxy failures return null without executing boundary accessors.
 */
function snapshotPlainDataRecord(
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = [],
): Readonly<PlainRecord> | null {
  try {
    if (typeof value !== 'object'
      || value === null
      || nodeTypes.isProxy(value)
      || Array.isArray(value)) {
      return null;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key))) return null;
    if (requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))) return null;

    const snapshot = Object.create(null) as PlainRecord;
    for (const key of ownKeys) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }

    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** Confirms an optional context identifier is absent or a non-empty string. */
function hasValidOptionalId(context: Readonly<PlainRecord>, key: 'intentId' | 'policyId'): boolean {
  if (!Object.prototype.hasOwnProperty.call(context, key)) return true;
  return typeof context[key] === 'string' && context[key].length > 0;
}

/** Confirms a compiled proof identifier is either intentionally absent or non-empty. */
function isNullableId(value: unknown): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

/** Snapshots context once, then validates identifiers and the mode-to-source relationship. */
function snapshotTrustedContext(context: unknown): TrustedExecutionContext | null {
  const snapshot = snapshotPlainDataRecord(context, CONTEXT_KEYS, ['mode', 'source']);
  if (!snapshot
    || !hasValidOptionalId(snapshot, 'intentId')
    || !hasValidOptionalId(snapshot, 'policyId')) {
    return null;
  }

  const validManualContext = snapshot.mode === 'manual'
    && (snapshot.source === 'renderer' || snapshot.source === 'telegram-approved');
  const validAutomaticContext = snapshot.mode === 'automatic'
    && (snapshot.source === 'incident'
      || snapshot.source === 'schedule'
      || snapshot.source === 'maintenance');

  return validManualContext || validAutomaticContext
    ? snapshot as unknown as TrustedExecutionContext
    : null;
}

/** Snapshots a dense, ordinary string array without invoking indexed accessors. */
function snapshotStringArray(value: unknown): readonly string[] | null {
  try {
    if (typeof value !== 'object'
      || value === null
      || nodeTypes.isProxy(value)
      || !Array.isArray(value)
      || Object.getPrototypeOf(value) !== Array.prototype) {
      return null;
    }

    const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
      PropertyKey,
      PropertyDescriptor
    >;
    const ownKeys = Reflect.ownKeys(descriptors);
    const lengthDescriptor = descriptors.length;
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')) return null;

    const length = lengthDescriptor.value;
    if (!Number.isSafeInteger(length) || length < 0 || ownKeys.length !== length + 1) return null;

    const snapshot: string[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')
        || typeof descriptor.value !== 'string'
        || descriptor.value.length === 0) {
        return null;
      }
      snapshot.push(descriptor.value);
    }

    if (ownKeys.some((key) => (
      typeof key !== 'string'
      || (key !== 'length' && !Number.isInteger(Number(key)))
    ))) return null;

    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

/** Confirms all compiled action metadata is present and structurally valid. */
function hasCompleteActionMetadata(input: Readonly<PlainRecord>): boolean {
  const validAutomation = input.automation === 'never'
    || input.automation === 'safe'
    || input.automation === 'conditional';

  return validAutomation
    && typeof input.rebootPolicy === 'string'
    && typeof input.requiresRollback === 'boolean'
    && isNullableId(input.preflightId)
    && isNullableId(input.postconditionId)
    && typeof input.cooldownMs === 'number'
    && Number.isFinite(input.cooldownMs)
    && input.cooldownMs >= 0
    && typeof input.maxAttempts === 'number'
    && Number.isInteger(input.maxAttempts)
    && input.maxAttempts >= 1
    && (input.confirmLevel === 'none'
      || input.confirmLevel === 'info'
      || input.confirmLevel === 'risky'
      || input.confirmLevel === 'destructive')
    && typeof input.rebootRequired === 'boolean';
}

/** Snapshots exact persisted policy state while preserving enabled for ordered denial. */
function snapshotPolicyState(policy: unknown): RuntimePolicyState | null {
  const snapshot = snapshotPlainDataRecord(policy, POLICY_KEYS, POLICY_KEYS);
  if (!snapshot
    || (snapshot.snoozedUntil !== null
      && (typeof snapshot.snoozedUntil !== 'number'
        || !Number.isFinite(snapshot.snoozedUntil)))) {
    return null;
  }

  return {
    enabled: snapshot.enabled,
    snoozedUntil: snapshot.snoozedUntil,
  } as RuntimePolicyState;
}

/** Snapshots exact evidence without rereading caller-controlled state. */
function snapshotEvidence(evidence: unknown): RuntimeEvidence | null {
  const snapshot = snapshotPlainDataRecord(evidence, EVIDENCE_KEYS, EVIDENCE_KEYS);
  return snapshot && (snapshot.state === 'fresh' || snapshot.state === 'stale')
    ? { state: snapshot.state }
    : null;
}

/** Snapshots all documented gates exactly once for ordered literal checks. */
function snapshotGates(gates: unknown): Readonly<PlainRecord> | null {
  return snapshotPlainDataRecord(gates, GATE_KEYS, GATE_KEYS);
}

/**
 * Returns the first policy decision for a trusted manual or automatic request.
 * Expected missing or failed policy inputs return denial codes and never throw.
 */
export function evaluateAutomationPolicy(input: AutomationPolicyInput): PolicyDecision {
  const inputSnapshot = snapshotPlainDataRecord(input, INPUT_KEYS);
  const context = inputSnapshot
    ? snapshotTrustedContext(inputSnapshot.context)
    : null;
  if (!inputSnapshot || !context) {
    return { allowed: false, code: 'E_CONTEXT_REQUIRED' };
  }

  // Manual execution remains governed by the existing confirmation UX, not automatic gates.
  if (context.mode === 'manual') {
    return { allowed: true, code: 'ALLOW' };
  }

  if (inputSnapshot.globalEnabled !== true) {
    return { allowed: false, code: 'E_AUTOMATION_DISABLED' };
  }

  const resourceLocks = snapshotStringArray(inputSnapshot.resourceLocks);
  if (resourceLocks === null || !hasCompleteActionMetadata(inputSnapshot)) {
    return { allowed: false, code: 'E_ACTION_METADATA_REQUIRED' };
  }

  if (inputSnapshot.automation === 'never') {
    return { allowed: false, code: 'E_AUTOMATION_NEVER' };
  }

  if (inputSnapshot.rebootPolicy !== 'never' || inputSnapshot.rebootRequired) {
    return { allowed: false, code: 'E_REBOOT_FORBIDDEN' };
  }

  if (inputSnapshot.confirmLevel === 'destructive') {
    return { allowed: false, code: 'E_DESTRUCTIVE_FORBIDDEN' };
  }

  const policy = snapshotPolicyState(inputSnapshot.policy);
  if (!policy
    || typeof inputSnapshot.now !== 'number'
    || !Number.isFinite(inputSnapshot.now)) {
    return { allowed: false, code: 'E_POLICY_REQUIRED' };
  }

  if (policy.enabled !== true) {
    return { allowed: false, code: 'E_POLICY_DISABLED' };
  }

  if (policy.snoozedUntil !== null && policy.snoozedUntil > inputSnapshot.now) {
    return { allowed: false, code: 'E_POLICY_SNOOZED' };
  }

  const evidence = snapshotEvidence(inputSnapshot.evidence);
  if (!evidence) {
    return { allowed: false, code: 'E_EVIDENCE_REQUIRED' };
  }

  if (evidence.state === 'stale') {
    return { allowed: false, code: 'E_EVIDENCE_STALE' };
  }

  const gates = snapshotGates(inputSnapshot.gates);
  if (!gates || gates.maintenanceWindowOpen !== true) {
    return { allowed: false, code: 'E_WINDOW_CLOSED' };
  }

  if (gates.loadAllowed !== true) {
    return { allowed: false, code: 'E_LOAD_BLOCKED' };
  }

  if (gates.idleSatisfied !== true) {
    return { allowed: false, code: 'E_IDLE_REQUIRED' };
  }

  if (resourceLocks.length > 0 && gates.locksAvailable !== true) {
    return { allowed: false, code: 'E_RESOURCE_LOCKED' };
  }

  if (gates.cooldownElapsed !== true) {
    return { allowed: false, code: 'E_COOLDOWN_ACTIVE' };
  }

  if (gates.attemptsRemaining !== true) {
    return { allowed: false, code: 'E_ATTEMPT_LIMIT' };
  }

  if (inputSnapshot.preflightId === null) {
    return { allowed: false, code: 'E_PREFLIGHT_REQUIRED' };
  }

  if (gates.preflightPassed !== true) {
    return { allowed: false, code: 'E_PREFLIGHT_FAILED' };
  }

  if (inputSnapshot.postconditionId === null) {
    return { allowed: false, code: 'E_POSTCONDITION_REQUIRED' };
  }

  if (inputSnapshot.requiresRollback && gates.rollbackReady !== true) {
    return { allowed: false, code: 'E_ROLLBACK_UNAVAILABLE' };
  }

  return { allowed: true, code: 'ALLOW' };
}
