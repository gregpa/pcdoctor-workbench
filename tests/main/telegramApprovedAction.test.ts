// @vitest-environment node
/**
 * Module: telegramApprovedAction.test.ts
 * Purpose: Prove approved Telegram callback actions receive only manual Telegram authority.
 * Dependencies: Vitest and a mocked actionRunner boundary.
 * Used by: The Phase 0 safety verification suite.
 * Key decisions: The helper is exercised directly because callback approval stays in main.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/actionRunner.js', () => ({
  runAction: vi.fn(async () => ({
    action: 'flush_dns',
    success: true,
    duration_ms: 1,
  })),
}));

vi.mock('../../src/main/dataStore.js', () => ({
  insertAutopilotActivity: vi.fn(),
}));

import { runAction } from '../../src/main/actionRunner.js';
import { insertAutopilotActivity } from '../../src/main/dataStore.js';
import {
  runAndRecordTelegramApprovedAction,
  runTelegramApprovedAction,
} from '../../src/main/telegramApprovedAction.js';

describe('runTelegramApprovedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Production break caught: a Telegram callback action receives automatic or missing authority.
  it('constructs manual telegram-approved context after callback approval', async () => {
    await runTelegramApprovedAction('flush_dns');

    expect(runAction).toHaveBeenCalledWith(
      { name: 'flush_dns', triggered_by: 'telegram' },
      { mode: 'manual', source: 'telegram-approved' },
    );
  });

  it('records a successful approved callback as manual_run', async () => {
    const result = await runAndRecordTelegramApprovedAction('flush_dns', 'low-disk-rule');

    expect(result.success).toBe(true);
    expect(runAction).toHaveBeenCalledWith(
      { name: 'flush_dns', triggered_by: 'telegram' },
      { mode: 'manual', source: 'telegram-approved' },
    );
    expect(insertAutopilotActivity).toHaveBeenCalledWith({
      rule_id: 'low-disk-rule',
      tier: 3,
      action_name: 'flush_dns',
      outcome: 'manual_run',
      duration_ms: 1,
      message: 'ran from Telegram button',
    });
  });

  it('records a failed approved callback as error', async () => {
    vi.mocked(runAction).mockResolvedValueOnce({
      action: 'flush_dns',
      success: false,
      duration_ms: 2,
      error: { code: 'E_ACTION_FAILED', message: 'failed' },
    });
    const result = await runAndRecordTelegramApprovedAction('flush_dns', 'low-disk-rule');

    expect(result.success).toBe(false);
    expect(insertAutopilotActivity).toHaveBeenCalledWith(expect.objectContaining({
      rule_id: 'low-disk-rule',
      outcome: 'error',
      message: 'failed',
    }));
  });

  it('uses an action-scoped rule id when callback data omits the rule id', async () => {
    await runAndRecordTelegramApprovedAction('flush_dns', '');

    expect(insertAutopilotActivity).toHaveBeenCalledWith(expect.objectContaining({
      rule_id: 'manual:flush_dns',
      outcome: 'manual_run',
    }));
  });
});
