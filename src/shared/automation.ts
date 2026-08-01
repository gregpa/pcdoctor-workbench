/**
 * Module: automation.ts
 * Purpose: Define immutable data contracts for trusted maintenance policy evaluation.
 * Dependencies: The existing action confirmation-level type.
 * Used by: The automation catalog, pure policy evaluator, and future maintenance orchestration.
 * Key decisions: Inputs permit absent boundary data so the evaluator can deny it without throwing.
 */

import type { ConfirmLevel } from './actions.js';

export type AutomationClass = 'never' | 'safe' | 'conditional';
export type RebootPolicy = 'never';
export type ExecutionMode = 'manual' | 'automatic';

export interface TrustedExecutionContext {
  readonly mode: ExecutionMode;
  readonly source: 'renderer' | 'telegram-approved' | 'incident' | 'schedule' | 'maintenance';
  readonly intentId?: string;
  readonly policyId?: string;
}

export interface ActionAutomationDefinition {
  readonly automation: AutomationClass;
  readonly rebootPolicy: RebootPolicy;
  readonly requiresRollback: boolean;
  readonly resourceLocks: readonly string[];
  readonly preflightId: string | null;
  readonly postconditionId: string | null;
  readonly cooldownMs: number;
  readonly maxAttempts: number;
}

export interface AutomationPolicyState {
  readonly enabled: boolean;
  readonly snoozedUntil: number | null;
}

export interface AutomationEvidence {
  readonly state: 'fresh' | 'stale';
}

export interface AutomationGateState {
  readonly maintenanceWindowOpen: boolean;
  readonly loadAllowed: boolean;
  readonly idleSatisfied: boolean;
  readonly locksAvailable: boolean;
  readonly cooldownElapsed: boolean;
  readonly attemptsRemaining: boolean;
  readonly preflightPassed: boolean;
  readonly rollbackReady: boolean;
}

export interface AutomationPolicyInput {
  readonly context?: TrustedExecutionContext;
  readonly globalEnabled: boolean;
  readonly automation?: AutomationClass;
  readonly rebootPolicy?: RebootPolicy;
  readonly requiresRollback?: boolean;
  readonly resourceLocks?: readonly string[];
  readonly preflightId?: string | null;
  readonly postconditionId?: string | null;
  readonly cooldownMs?: number;
  readonly maxAttempts?: number;
  readonly confirmLevel?: ConfirmLevel;
  readonly rebootRequired?: boolean;
  readonly policy?: AutomationPolicyState;
  readonly evidence?: AutomationEvidence;
  readonly gates?: AutomationGateState;
  readonly now: number;
}

export type AutomationDenialCode =
  | 'E_CONTEXT_REQUIRED'
  | 'E_AUTOMATION_DISABLED'
  | 'E_ACTION_METADATA_REQUIRED'
  | 'E_AUTOMATION_NEVER'
  | 'E_REBOOT_FORBIDDEN'
  | 'E_DESTRUCTIVE_FORBIDDEN'
  | 'E_POLICY_REQUIRED'
  | 'E_POLICY_DISABLED'
  | 'E_POLICY_SNOOZED'
  | 'E_EVIDENCE_REQUIRED'
  | 'E_EVIDENCE_STALE'
  | 'E_WINDOW_CLOSED'
  | 'E_LOAD_BLOCKED'
  | 'E_IDLE_REQUIRED'
  | 'E_RESOURCE_LOCKED'
  | 'E_COOLDOWN_ACTIVE'
  | 'E_ATTEMPT_LIMIT'
  | 'E_PREFLIGHT_REQUIRED'
  | 'E_PREFLIGHT_FAILED'
  | 'E_POSTCONDITION_REQUIRED'
  | 'E_ROLLBACK_UNAVAILABLE';

export type PolicyDecision =
  | { readonly allowed: true; readonly code: 'ALLOW' }
  | { readonly allowed: false; readonly code: AutomationDenialCode };
