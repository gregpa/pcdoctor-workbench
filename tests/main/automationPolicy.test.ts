/**
 * Module: automationPolicy.test.ts
 * Purpose: Prove automatic maintenance is denied at every policy boundary.
 * Dependencies: Vitest and the pure automation policy contract.
 * Used by: The Phase 0 source verification gate.
 * Key decisions: Expected denial codes are literal so tests cannot mirror production logic.
 */

import { describe, expect, it } from 'vitest';
import { evaluateAutomationPolicy } from '../../src/main/automationPolicy.js';
import { ACTIONS } from '../../src/shared/actions.js';
import {
  ACTION_AUTOMATION,
  neverAutomatic,
  safeAutomatic,
} from '../../src/shared/automationCatalog.js';
import type {
  AutomationPolicyInput,
  PolicyDecision,
} from '../../src/shared/automation.js';

const NOW = 1_900_000_000_000;

function base(overrides: Partial<AutomationPolicyInput> = {}): AutomationPolicyInput {
  return {
    context: {
      mode: 'automatic',
      source: 'schedule',
      intentId: 'intent-defender-update',
      policyId: 'policy-defender-update',
    },
    globalEnabled: true,
    automation: 'safe',
    rebootPolicy: 'never',
    requiresRollback: false,
    resourceLocks: ['defender'],
    preflightId: 'defender-update-preflight',
    postconditionId: 'defender-definitions-current',
    cooldownMs: 3_600_000,
    maxAttempts: 2,
    confirmLevel: 'none',
    rebootRequired: false,
    policy: { enabled: true, snoozedUntil: null },
    evidence: { state: 'fresh' },
    gates: {
      maintenanceWindowOpen: true,
      loadAllowed: true,
      idleSatisfied: true,
      locksAvailable: true,
      cooldownElapsed: true,
      attemptsRemaining: true,
      preflightPassed: true,
      rollbackReady: true,
    },
    now: NOW,
    ...overrides,
  };
}

function expectDenied(input: AutomationPolicyInput, code: PolicyDecision['code']): void {
  expect(evaluateAutomationPolicy(input)).toEqual({ allowed: false, code });
}

describe('evaluateAutomationPolicy', () => {
  // Production break caught: an untrusted caller reaches policy evaluation without execution context.
  it('denies missing execution context without throwing', () => {
    expect(() => evaluateAutomationPolicy(base({ context: undefined }))).not.toThrow();
    expectDenied(base({ context: undefined }), 'E_CONTEXT_REQUIRED');
  });

  // Production break caught: a malformed execution source is treated as trusted context.
  it('denies unknown execution context without throwing', () => {
    const context = { mode: 'automatic', source: 'unknown' } as unknown as AutomationPolicyInput['context'];

    expect(() => evaluateAutomationPolicy(base({ context }))).not.toThrow();
    expectDenied(base({ context }), 'E_CONTEXT_REQUIRED');
  });

  // Production break caught: the automatic kill switch is bypassed.
  it('denies automatic execution when the global switch is disabled', () => {
    expectDenied(base({ globalEnabled: false }), 'E_AUTOMATION_DISABLED');
  });

  // Production break caught: a caller can omit one part of the compiled action metadata.
  it.each([
    ['automation', { automation: undefined }],
    ['rebootPolicy', { rebootPolicy: undefined }],
    ['requiresRollback', { requiresRollback: undefined }],
    ['resourceLocks', { resourceLocks: undefined }],
    ['preflightId', { preflightId: undefined }],
    ['postconditionId', { postconditionId: undefined }],
    ['cooldownMs', { cooldownMs: undefined }],
    ['maxAttempts', { maxAttempts: undefined }],
    ['confirmLevel', { confirmLevel: undefined }],
    ['rebootRequired', { rebootRequired: undefined }],
  ] satisfies ReadonlyArray<[string, Partial<AutomationPolicyInput>]>) (
    'denies missing %s action metadata',
    (_field, override) => {
      expectDenied(base(override), 'E_ACTION_METADATA_REQUIRED');
    },
  );

  // Production break caught: malformed cooldown or attempt limits are accepted as trusted metadata.
  it.each([
    ['negative cooldown', { cooldownMs: -1 }],
    ['non-finite cooldown', { cooldownMs: Number.NaN }],
    ['zero attempts', { maxAttempts: 0 }],
    ['fractional attempts', { maxAttempts: 1.5 }],
  ] satisfies ReadonlyArray<[string, Partial<AutomationPolicyInput>]>) (
    'denies malformed metadata: %s',
    (_caseName, override) => {
      expectDenied(base(override), 'E_ACTION_METADATA_REQUIRED');
    },
  );

  // Production break caught: an action classified as never automatic is dispatched automatically.
  it('denies actions classified as never automatic', () => {
    expectDenied(base({ automation: 'never' }), 'E_AUTOMATION_NEVER');
  });

  // Production break caught: automatic execution can request or require a reboot.
  it.each([
    ['action requires reboot', { rebootRequired: true }],
    ['metadata permits reboot', { rebootPolicy: 'restart' as 'never' }],
  ] satisfies ReadonlyArray<[string, Partial<AutomationPolicyInput>]>) (
    'denies reboot behavior: %s',
    (_caseName, override) => {
      expectDenied(base(override), 'E_REBOOT_FORBIDDEN');
    },
  );

  // Production break caught: a destructive action crosses the automatic boundary.
  it('denies destructive actions', () => {
    expectDenied(base({ confirmLevel: 'destructive' }), 'E_DESTRUCTIVE_FORBIDDEN');
  });

  // Production break caught: an automatic action runs without a persisted policy decision.
  it('denies missing policy state', () => {
    expectDenied(base({ policy: undefined }), 'E_POLICY_REQUIRED');
  });

  // Production break caught: a disabled policy still dispatches its action.
  it('denies disabled policy state', () => {
    expectDenied(base({ policy: { enabled: false, snoozedUntil: null } }), 'E_POLICY_DISABLED');
  });

  // Production break caught: a future snooze expiration is ignored.
  it('denies a policy snoozed beyond the evaluation time', () => {
    expectDenied(base({ policy: { enabled: true, snoozedUntil: NOW + 1 } }), 'E_POLICY_SNOOZED');
  });

  // Production break caught: an automatic action runs without evidence.
  it('denies missing evidence', () => {
    expectDenied(base({ evidence: undefined }), 'E_EVIDENCE_REQUIRED');
  });

  // Production break caught: stale evidence is treated as current proof.
  it('denies stale evidence', () => {
    expectDenied(base({ evidence: { state: 'stale' } }), 'E_EVIDENCE_STALE');
  });

  // Production break caught: an action begins outside its maintenance window.
  it('denies a closed maintenance window', () => {
    expectDenied(base({ gates: { ...base().gates!, maintenanceWindowOpen: false } }), 'E_WINDOW_CLOSED');
  });

  // Production break caught: an action begins while the machine load gate is closed.
  it('denies blocked machine load', () => {
    expectDenied(base({ gates: { ...base().gates!, loadAllowed: false } }), 'E_LOAD_BLOCKED');
  });

  // Production break caught: an action begins without workload-specific idle proof.
  it('denies missing idle proof', () => {
    expectDenied(base({ gates: { ...base().gates!, idleSatisfied: false } }), 'E_IDLE_REQUIRED');
  });

  // Production break caught: an action with declared locks runs without acquiring them.
  it('denies unavailable resource locks when the action declares locks', () => {
    expectDenied(base({ gates: { ...base().gates!, locksAvailable: false } }), 'E_RESOURCE_LOCKED');
  });

  // Production break caught: an action with no declared locks is incorrectly blocked by lock state.
  it('does not require lock acquisition when the action declares no locks', () => {
    const input = base({
      resourceLocks: [],
      gates: { ...base().gates!, locksAvailable: false },
    });

    expect(evaluateAutomationPolicy(input)).toEqual({ allowed: true, code: 'ALLOW' });
  });

  // Production break caught: the action cooldown is bypassed.
  it('denies an active cooldown', () => {
    expectDenied(base({ gates: { ...base().gates!, cooldownElapsed: false } }), 'E_COOLDOWN_ACTIVE');
  });

  // Production break caught: the bounded attempt budget is exceeded.
  it('denies an exhausted attempt budget', () => {
    expectDenied(base({ gates: { ...base().gates!, attemptsRemaining: false } }), 'E_ATTEMPT_LIMIT');
  });

  // Production break caught: a safe action has no compiled preflight contract.
  it('denies missing preflight identity', () => {
    expectDenied(base({ preflightId: null }), 'E_PREFLIGHT_REQUIRED');
  });

  // Production break caught: failed preflight is ignored.
  it('denies failed preflight', () => {
    expectDenied(base({ gates: { ...base().gates!, preflightPassed: false } }), 'E_PREFLIGHT_FAILED');
  });

  // Production break caught: a safe action has no compiled postcondition contract.
  it('denies missing postcondition identity', () => {
    expectDenied(base({ postconditionId: null }), 'E_POSTCONDITION_REQUIRED');
  });

  // Production break caught: a rollback-dependent action runs without rollback readiness.
  it('denies missing rollback readiness when rollback is required', () => {
    expectDenied(base({
      requiresRollback: true,
      gates: { ...base().gates!, rollbackReady: false },
    }), 'E_ROLLBACK_UNAVAILABLE');
  });

  // Production break caught: a missing gate bundle defaults to allow.
  it('fails closed at the first gate when gate evidence is missing', () => {
    expectDenied(base({ gates: undefined }), 'E_WINDOW_CLOSED');
  });

  // Production break caught: manual renderer actions are accidentally coupled to automatic gates.
  it('allows a trusted manual renderer context before automatic policy checks', () => {
    const decision = evaluateAutomationPolicy(base({
      context: { mode: 'manual', source: 'renderer' },
      globalEnabled: false,
      automation: undefined,
      policy: undefined,
      evidence: undefined,
      gates: undefined,
    }));

    expect(decision).toEqual({ allowed: true, code: 'ALLOW' });
  });

  // Production break caught: a fully proven safe action is denied after all gates pass.
  it('allows a safe automatic action with complete fresh evidence and passing gates', () => {
    expect(evaluateAutomationPolicy(base())).toEqual({ allowed: true, code: 'ALLOW' });
  });

  // Production break caught: a later denial masks the earliest failed safety boundary.
  it.each([
    ['context before global', { context: undefined, globalEnabled: false }, 'E_CONTEXT_REQUIRED'],
    ['global before metadata', { globalEnabled: false, automation: undefined }, 'E_AUTOMATION_DISABLED'],
    ['metadata before never', { automation: undefined, rebootRequired: true }, 'E_ACTION_METADATA_REQUIRED'],
    ['never before reboot', { automation: 'never', rebootRequired: true }, 'E_AUTOMATION_NEVER'],
    ['reboot before destructive', { rebootRequired: true, confirmLevel: 'destructive' }, 'E_REBOOT_FORBIDDEN'],
    ['destructive before policy', { confirmLevel: 'destructive', policy: undefined }, 'E_DESTRUCTIVE_FORBIDDEN'],
    ['policy required before evidence', { policy: undefined, evidence: undefined }, 'E_POLICY_REQUIRED'],
    ['policy disabled before snooze', { policy: { enabled: false, snoozedUntil: NOW + 1 }, evidence: undefined }, 'E_POLICY_DISABLED'],
    ['snooze before evidence', { policy: { enabled: true, snoozedUntil: NOW + 1 }, evidence: undefined }, 'E_POLICY_SNOOZED'],
    ['evidence required before window', { evidence: undefined, gates: { ...base().gates!, maintenanceWindowOpen: false } }, 'E_EVIDENCE_REQUIRED'],
    ['stale evidence before window', { evidence: { state: 'stale' }, gates: { ...base().gates!, maintenanceWindowOpen: false } }, 'E_EVIDENCE_STALE'],
    ['window before load', { gates: { ...base().gates!, maintenanceWindowOpen: false, loadAllowed: false } }, 'E_WINDOW_CLOSED'],
    ['load before idle', { gates: { ...base().gates!, loadAllowed: false, idleSatisfied: false } }, 'E_LOAD_BLOCKED'],
    ['idle before locks', { gates: { ...base().gates!, idleSatisfied: false, locksAvailable: false } }, 'E_IDLE_REQUIRED'],
    ['locks before cooldown', { gates: { ...base().gates!, locksAvailable: false, cooldownElapsed: false } }, 'E_RESOURCE_LOCKED'],
    ['cooldown before attempts', { gates: { ...base().gates!, cooldownElapsed: false, attemptsRemaining: false } }, 'E_COOLDOWN_ACTIVE'],
    ['attempts before preflight identity', { preflightId: null, gates: { ...base().gates!, attemptsRemaining: false } }, 'E_ATTEMPT_LIMIT'],
    ['preflight identity before result', { preflightId: null, gates: { ...base().gates!, preflightPassed: false } }, 'E_PREFLIGHT_REQUIRED'],
    ['preflight result before postcondition', { postconditionId: null, gates: { ...base().gates!, preflightPassed: false } }, 'E_PREFLIGHT_FAILED'],
    ['postcondition before rollback', { postconditionId: null, requiresRollback: true, gates: { ...base().gates!, rollbackReady: false } }, 'E_POSTCONDITION_REQUIRED'],
  ] satisfies ReadonlyArray<[string, Partial<AutomationPolicyInput>, PolicyDecision['code']]>) (
    'returns the first denial: %s',
    (_caseName, override, expectedCode) => {
      expectDenied(base(override), expectedCode);
    },
  );
});

describe('ACTION_AUTOMATION', () => {
  // Production break caught: the action and automation catalogs drift at runtime.
  it('has exactly one entry for every current action', () => {
    expect(Object.keys(ACTION_AUTOMATION).sort()).toEqual(Object.keys(ACTIONS).sort());
  });

  // Production break caught: Phase 0 silently enables an existing action for automation.
  it('classifies every current action as never automatic with reboot forbidden', () => {
    for (const definition of Object.values(ACTION_AUTOMATION)) {
      expect(definition.automation).toBe('never');
      expect(definition.rebootPolicy).toBe('never');
    }
  });

  // Production break caught: callers mutate authoritative metadata after import.
  it('keeps catalog entries and lock arrays immutable at runtime', () => {
    const definition = ACTION_AUTOMATION.flush_dns;

    expect(Reflect.set(definition, 'automation', 'safe')).toBe(false);
    expect(Reflect.set(definition.resourceLocks, 0, 'network')).toBe(false);
    expect(definition).toEqual(neverAutomatic());
  });

  // Production break caught: a caller replaces a catalog entry after import.
  it('keeps the authoritative catalog mapping immutable at runtime', () => {
    expect(Reflect.set(ACTION_AUTOMATION, 'flush_dns', safeAutomatic())).toBe(false);
    expect(ACTION_AUTOMATION.flush_dns).toEqual(neverAutomatic());
  });

  // Production break caught: the future safe helper creates mutable or reboot-capable metadata.
  it('creates immutable fail-closed safe metadata for future catalog entries', () => {
    const definition = safeAutomatic();

    expect(definition).toEqual({
      automation: 'safe',
      rebootPolicy: 'never',
      requiresRollback: false,
      resourceLocks: [],
      preflightId: null,
      postconditionId: null,
      cooldownMs: 0,
      maxAttempts: 1,
    });
    expect(Reflect.set(definition, 'rebootPolicy', 'restart')).toBe(false);
  });
});
