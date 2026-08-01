/**
 * Module: automationPolicy.ts
 * Purpose: Evaluate automatic maintenance eligibility without side effects.
 * Dependencies: Shared policy input and decision contracts only.
 * Used by: Future automatic execution boundaries and focused policy tests.
 * Key decisions: Checks are ordered from trust boundaries to action proofs and return the first denial.
 */

import type {
  AutomationPolicyInput,
  PolicyDecision,
  TrustedExecutionContext,
} from '../shared/automation.js';

const CONTEXT_KEYS = ['mode', 'source', 'intentId', 'policyId'] as const;
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

interface RuntimePolicyState extends PlainRecord {
  enabled: unknown;
  snoozedUntil: number | null;
}

interface RuntimeEvidence extends PlainRecord {
  state: 'fresh' | 'stale';
}

/** Confirms a boundary value is a plain, non-array record. */
function isPlainRecord(value: unknown): value is PlainRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Confirms every own key is allowlisted and no symbol or hidden key bypasses the check. */
function hasOnlyOwnKeys(record: PlainRecord, allowedKeys: readonly string[]): boolean {
  return Reflect.ownKeys(record).every((key) => (
    typeof key === 'string' && allowedKeys.includes(key)
  ));
}

/** Confirms a record contains exactly the required own keys. */
function hasExactOwnKeys(record: PlainRecord, requiredKeys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(record);
  return ownKeys.length === requiredKeys.length
    && ownKeys.every((key) => typeof key === 'string' && requiredKeys.includes(key));
}

/** Confirms an optional context identifier is absent or a non-empty string. */
function hasValidOptionalId(context: PlainRecord, key: 'intentId' | 'policyId'): boolean {
  if (!Object.prototype.hasOwnProperty.call(context, key)) return true;
  return typeof context[key] === 'string' && context[key].length > 0;
}

/** Confirms a compiled proof identifier is either intentionally absent or non-empty. */
function isNullableId(value: string | null | undefined): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

/** Confirms context shape, identifiers, and mode-to-source trust relationship. */
function isTrustedContext(context: unknown): context is TrustedExecutionContext {
  if (!isPlainRecord(context) || !hasOnlyOwnKeys(context, CONTEXT_KEYS)) return false;
  if (!hasValidOptionalId(context, 'intentId') || !hasValidOptionalId(context, 'policyId')) return false;

  const validManualContext = context.mode === 'manual'
    && (context.source === 'renderer' || context.source === 'telegram-approved');
  const validAutomaticContext = context.mode === 'automatic'
    && (context.source === 'incident'
      || context.source === 'schedule'
      || context.source === 'maintenance');

  return validManualContext || validAutomaticContext;
}

/** Confirms all compiled action metadata is present and structurally valid. */
function hasCompleteActionMetadata(input: AutomationPolicyInput): boolean {
  const validAutomation = input.automation === 'never'
    || input.automation === 'safe'
    || input.automation === 'conditional';

  return validAutomation
    && typeof input.rebootPolicy === 'string'
    && typeof input.requiresRollback === 'boolean'
    && Array.isArray(input.resourceLocks)
    && input.resourceLocks.every((lock) => typeof lock === 'string' && lock.length > 0)
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

/** Confirms policy timing can be evaluated without accepting malformed containers. */
function isPolicyState(policy: unknown): policy is RuntimePolicyState {
  return isPlainRecord(policy)
    && (policy.snoozedUntil === null
      || (typeof policy.snoozedUntil === 'number' && Number.isFinite(policy.snoozedUntil)));
}

/** Confirms evidence is the exact trusted freshness payload. */
function isEvidence(evidence: unknown): evidence is RuntimeEvidence {
  return isPlainRecord(evidence)
    && hasExactOwnKeys(evidence, ['state'])
    && (evidence.state === 'fresh' || evidence.state === 'stale');
}

/** Confirms the gate bundle is a plain record with every documented gate and no extras. */
function hasExactGateShape(gates: unknown): gates is PlainRecord {
  return isPlainRecord(gates) && hasExactOwnKeys(gates, GATE_KEYS);
}

/**
 * Returns the first policy decision for a trusted manual or automatic request.
 * Expected missing or failed policy inputs return denial codes and never throw.
 */
export function evaluateAutomationPolicy(input: AutomationPolicyInput): PolicyDecision {
  if (!isPlainRecord(input) || !isTrustedContext(input.context)) {
    return { allowed: false, code: 'E_CONTEXT_REQUIRED' };
  }

  // Manual execution remains governed by the existing confirmation UX, not automatic gates.
  if (input.context.mode === 'manual') {
    return { allowed: true, code: 'ALLOW' };
  }

  if (input.globalEnabled !== true) {
    return { allowed: false, code: 'E_AUTOMATION_DISABLED' };
  }

  if (!hasCompleteActionMetadata(input)) {
    return { allowed: false, code: 'E_ACTION_METADATA_REQUIRED' };
  }

  if (input.automation === 'never') {
    return { allowed: false, code: 'E_AUTOMATION_NEVER' };
  }

  if (input.rebootPolicy !== 'never' || input.rebootRequired) {
    return { allowed: false, code: 'E_REBOOT_FORBIDDEN' };
  }

  if (input.confirmLevel === 'destructive') {
    return { allowed: false, code: 'E_DESTRUCTIVE_FORBIDDEN' };
  }

  if (!isPolicyState(input.policy)
    || typeof input.now !== 'number'
    || !Number.isFinite(input.now)) {
    return { allowed: false, code: 'E_POLICY_REQUIRED' };
  }

  if (input.policy.enabled !== true) {
    return { allowed: false, code: 'E_POLICY_DISABLED' };
  }

  if (input.policy.snoozedUntil !== null && input.policy.snoozedUntil > input.now) {
    return { allowed: false, code: 'E_POLICY_SNOOZED' };
  }

  if (!isEvidence(input.evidence)) {
    return { allowed: false, code: 'E_EVIDENCE_REQUIRED' };
  }

  if (input.evidence.state === 'stale') {
    return { allowed: false, code: 'E_EVIDENCE_STALE' };
  }

  const gates = input.gates;
  if (!hasExactGateShape(gates) || gates.maintenanceWindowOpen !== true) {
    return { allowed: false, code: 'E_WINDOW_CLOSED' };
  }

  if (gates.loadAllowed !== true) {
    return { allowed: false, code: 'E_LOAD_BLOCKED' };
  }

  if (gates.idleSatisfied !== true) {
    return { allowed: false, code: 'E_IDLE_REQUIRED' };
  }

  if ((input.resourceLocks?.length ?? 0) > 0 && gates.locksAvailable !== true) {
    return { allowed: false, code: 'E_RESOURCE_LOCKED' };
  }

  if (gates.cooldownElapsed !== true) {
    return { allowed: false, code: 'E_COOLDOWN_ACTIVE' };
  }

  if (gates.attemptsRemaining !== true) {
    return { allowed: false, code: 'E_ATTEMPT_LIMIT' };
  }

  if (input.preflightId === null) {
    return { allowed: false, code: 'E_PREFLIGHT_REQUIRED' };
  }

  if (gates.preflightPassed !== true) {
    return { allowed: false, code: 'E_PREFLIGHT_FAILED' };
  }

  if (input.postconditionId === null) {
    return { allowed: false, code: 'E_POSTCONDITION_REQUIRED' };
  }

  if (input.requiresRollback && gates.rollbackReady !== true) {
    return { allowed: false, code: 'E_ROLLBACK_UNAVAILABLE' };
  }

  return { allowed: true, code: 'ALLOW' };
}
