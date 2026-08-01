// @vitest-environment node
/**
 * Module: telegramApprovedAction.test.ts
 * Purpose: Prove approved Telegram callback actions receive only manual Telegram authority.
 * Dependencies: Vitest and a mocked actionRunner boundary.
 * Used by: The Phase 0 safety verification suite.
 * Key decisions: The helper is exercised directly because callback approval stays in main.ts.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/main/actionRunner.js', () => ({
  runAction: vi.fn(async () => ({
    action: 'flush_dns',
    success: true,
    duration_ms: 1,
  })),
}));

import { runAction } from '../../src/main/actionRunner.js';
import { runTelegramApprovedAction } from '../../src/main/telegramApprovedAction.js';

describe('runTelegramApprovedAction', () => {
  // Production break caught: a Telegram callback action receives automatic or missing authority.
  it('constructs manual telegram-approved context after callback approval', async () => {
    await runTelegramApprovedAction('flush_dns');

    expect(runAction).toHaveBeenCalledWith(
      { name: 'flush_dns', triggered_by: 'telegram' },
      { mode: 'manual', source: 'telegram-approved' },
    );
  });
});
