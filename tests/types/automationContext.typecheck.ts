import type { TrustedExecutionContext } from '../../src/shared/automation.js';

type IsAssignable<Value, Target> = Value extends Target ? true : false;
type ExpectTrue<Value extends true> = Value;

type ManualRendererIsValid = ExpectTrue<IsAssignable<{
  readonly mode: 'manual';
  readonly source: 'renderer';
}, TrustedExecutionContext>>;

type ManualTelegramIsValid = ExpectTrue<IsAssignable<{
  readonly mode: 'manual';
  readonly source: 'telegram-approved';
}, TrustedExecutionContext>>;

type AutomaticIncidentIsValid = ExpectTrue<IsAssignable<{
  readonly mode: 'automatic';
  readonly source: 'incident';
}, TrustedExecutionContext>>;

type AutomaticScheduleIsValid = ExpectTrue<IsAssignable<{
  readonly mode: 'automatic';
  readonly source: 'schedule';
  readonly intentId: 'intent-1';
  readonly policyId: 'policy-1';
}, TrustedExecutionContext>>;

type AutomaticMaintenanceIsValid = ExpectTrue<IsAssignable<{
  readonly mode: 'automatic';
  readonly source: 'maintenance';
}, TrustedExecutionContext>>;

// @ts-expect-error Manual contexts cannot claim an automatic source.
type ManualIncidentIsInvalid = ExpectTrue<IsAssignable<{
  readonly mode: 'manual';
  readonly source: 'incident';
}, TrustedExecutionContext>>;

// @ts-expect-error Automatic contexts cannot claim a manual source.
type AutomaticRendererIsInvalid = ExpectTrue<IsAssignable<{
  readonly mode: 'automatic';
  readonly source: 'renderer';
}, TrustedExecutionContext>>;

export type AutomationContextTypeAssertions =
  | ManualRendererIsValid
  | ManualTelegramIsValid
  | AutomaticIncidentIsValid
  | AutomaticScheduleIsValid
  | AutomaticMaintenanceIsValid
  | ManualIncidentIsInvalid
  | AutomaticRendererIsInvalid;
