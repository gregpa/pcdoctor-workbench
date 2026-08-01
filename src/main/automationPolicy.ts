/**
 * Module: automationPolicy.ts
 * Purpose: Evaluate automatic maintenance eligibility without side effects.
 * Dependencies: Shared policy input and decision contracts only.
 * Used by: Future automatic execution boundaries and focused policy tests.
 * Key decisions: Checks are ordered from trust boundaries to action proofs and return the first denial.
 */

import type {
  AutomationEvidence,
  AutomationPolicyInput,
  AutomationPolicyState,
  PolicyDecision,
  TrustedExecutionContext,
} from '../shared/automation.js';

/** Confirms a compiled proof identifier is either intentionally absent or non-empty. */
function isNullableId(value: string | null | undefined): boolean {
  return value === null || (typeof value === 'string' && value.length > 0);
}

/** Confirms the context contains only a known execution mode and source. */
function isTrustedContext(context: TrustedExecutionContext | undefined): context is TrustedExecutionContext {
  if (!context || (context.mode !== 'manual' && context.mode !== 'automatic')) return false;

  return context.source === 'renderer'
    || context.source === 'telegram-approved'
    || context.source === 'incident'
    || context.source === 'schedule'
    || context.source === 'maintenance';
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

/** Confirms persisted policy state is complete enough for ordered evaluation. */
function isPolicyState(policy: AutomationPolicyState | undefined): policy is AutomationPolicyState {
  return policy !== undefined
    && typeof policy.enabled === 'boolean'
    && (policy.snoozedUntil === null
      || (typeof policy.snoozedUntil === 'number' && Number.isFinite(policy.snoozedUntil)));
}

/** Confirms evidence has a known freshness state. */
function isEvidence(evidence: AutomationEvidence | undefined): evidence is AutomationEvidence {
  return evidence?.state === 'fresh' || evidence?.state === 'stale';
}

/**
 * Returns the first policy decision for a trusted manual or automatic request.
 * Expected missing or failed policy inputs return denial codes and never throw.
 */
export function evaluateAutomationPolicy(input: AutomationPolicyInput): PolicyDecision {
  if (!isTrustedContext(input.context)) {
    return { allowed: false, code: 'E_CONTEXT_REQUIRED' };
  }

  // Manual execution remains governed by the existing confirmation UX, not automatic gates.
  if (input.context.mode === 'manual') {
    return { allowed: true, code: 'ALLOW' };
  }

  if (!input.globalEnabled) {
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

  if (!isPolicyState(input.policy)) {
    return { allowed: false, code: 'E_POLICY_REQUIRED' };
  }

  if (!input.policy.enabled) {
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

  if (input.gates?.maintenanceWindowOpen !== true) {
    return { allowed: false, code: 'E_WINDOW_CLOSED' };
  }

  if (input.gates.loadAllowed !== true) {
    return { allowed: false, code: 'E_LOAD_BLOCKED' };
  }

  if (input.gates.idleSatisfied !== true) {
    return { allowed: false, code: 'E_IDLE_REQUIRED' };
  }

  if ((input.resourceLocks?.length ?? 0) > 0 && input.gates.locksAvailable !== true) {
    return { allowed: false, code: 'E_RESOURCE_LOCKED' };
  }

  if (input.gates.cooldownElapsed !== true) {
    return { allowed: false, code: 'E_COOLDOWN_ACTIVE' };
  }

  if (input.gates.attemptsRemaining !== true) {
    return { allowed: false, code: 'E_ATTEMPT_LIMIT' };
  }

  if (input.preflightId === null) {
    return { allowed: false, code: 'E_PREFLIGHT_REQUIRED' };
  }

  if (input.gates.preflightPassed !== true) {
    return { allowed: false, code: 'E_PREFLIGHT_FAILED' };
  }

  if (input.postconditionId === null) {
    return { allowed: false, code: 'E_POSTCONDITION_REQUIRED' };
  }

  if (input.requiresRollback && input.gates.rollbackReady !== true) {
    return { allowed: false, code: 'E_ROLLBACK_UNAVAILABLE' };
  }

  return { allowed: true, code: 'ALLOW' };
}
