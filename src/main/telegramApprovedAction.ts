/**
 * Module: telegramApprovedAction.ts
 * Purpose: Bind Telegram callback-approved actions to manual trusted execution context.
 * Dependencies: actionRunner, dataStore, and the shared action/result types.
 * Used by: The existing Telegram callback approval branches in main.ts.
 * Key decisions: Approval remains in main.ts; this boundary keeps manual authority and activity attribution together.
 */

import type { ActionName, ActionResult } from '@shared/types.js';
import { runAction } from './actionRunner.js';
import { insertAutopilotActivity } from './dataStore.js';

/** Runs an action after an existing Telegram callback branch has approved it. */
export function runTelegramApprovedAction(name: ActionName): Promise<ActionResult> {
  return runAction(
    { name, triggered_by: 'telegram' },
    { mode: 'manual', source: 'telegram-approved' },
  );
}

/** Runs and records an Autopilot action approved through a Telegram callback. */
export async function runAndRecordTelegramApprovedAction(
  name: ActionName,
  ruleId: string,
): Promise<ActionResult> {
  const result = await runTelegramApprovedAction(name);
  insertAutopilotActivity({
    rule_id: ruleId || `manual:${name}`,
    tier: 3,
    action_name: name,
    outcome: result.success ? 'manual_run' : 'error',
    duration_ms: result.duration_ms,
    message: result.success ? 'ran from Telegram button' : (result.error?.message ?? 'error'),
  });
  return result;
}
