/**
 * Module: telegramApprovedAction.ts
 * Purpose: Bind Telegram callback-approved actions to manual trusted execution context.
 * Dependencies: actionRunner and the shared action/result types.
 * Used by: The existing Telegram callback approval branches in main.ts.
 * Key decisions: Approval remains in main.ts; this boundary only constructs non-automatic authority.
 */

import type { ActionName, ActionResult } from '@shared/types.js';
import { runAction } from './actionRunner.js';

/** Runs an action after an existing Telegram callback branch has approved it. */
export function runTelegramApprovedAction(name: ActionName): Promise<ActionResult> {
  return runAction(
    { name, triggered_by: 'telegram' },
    { mode: 'manual', source: 'telegram-approved' },
  );
}
