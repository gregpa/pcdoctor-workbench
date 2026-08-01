// @vitest-environment node
/**
 * Module: actionRunner.automationPolicy.test.ts
 * Purpose: Prove actionRunner enforces trusted execution policy before rollback or script dispatch.
 * Dependencies: Vitest, the real Phase 0 automation policy/catalog, and mocked process side effects.
 * Used by: The Phase 0 safety verification suite.
 * Key decisions: Only the unreachable future rollback branch substitutes policy metadata and an allow decision.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSetting } = vi.hoisted(() => ({
  getSetting: vi.fn((): string | null => '0'),
}));

vi.mock('../../src/main/scriptRunner.js', () => ({
  runPowerShellScript: vi.fn(async () => ({ success: true, message: 'ok' })),
  runElevatedPowerShellScript: vi.fn(async () => ({ success: true, message: 'ok' })),
  isUacEnabled: vi.fn(() => true),
  PCDoctorScriptError: class extends Error {
    code: string;
    details?: unknown;
  },
}));

vi.mock('../../src/main/dataStore.js', () => ({
  startActionLog: vi.fn(() => 41),
  finishActionLog: vi.fn(),
  insertToolResult: vi.fn(),
  updateActionLogRollbackId: vi.fn(),
  getSetting,
}));

vi.mock('../../src/main/rollbackManager.js', () => ({
  prepareRollback: vi.fn(async () => null),
}));

vi.mock('../../src/main/notifier.js', () => ({
  notify: vi.fn(async () => {}),
}));

import { runAction } from '../../src/main/actionRunner.js';
import { finishActionLog, startActionLog } from '../../src/main/dataStore.js';
import { prepareRollback } from '../../src/main/rollbackManager.js';
import {
  runElevatedPowerShellScript,
  runPowerShellScript,
} from '../../src/main/scriptRunner.js';

const MANUAL_RENDERER = { mode: 'manual', source: 'renderer' } as const;
const AUTOMATIC_INCIDENT = {
  mode: 'automatic',
  source: 'incident',
  policyId: 'phase0-test-policy',
} as const;
let consoleWarnSpy: { mockRestore(): void };

beforeEach(() => {
  consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  consoleWarnSpy.mockRestore();
});

function expectNoMutationDispatch(): void {
  expect(prepareRollback).not.toHaveBeenCalled();
  expect(runPowerShellScript).not.toHaveBeenCalled();
  expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
}

describe('runAction trusted automation boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSetting.mockReturnValue('0');
  });

  // Production break caught: legacy one-argument callers bypass policy evaluation.
  it('denies a missing trusted context without rollback or script dispatch', async () => {
    const result = await (runAction as any)({ name: 'flush_dns' });

    expect(result).toMatchObject({
      success: false,
      error: { code: 'E_CONTEXT_REQUIRED' },
    });
    expect(finishActionLog).toHaveBeenCalledWith(41, expect.objectContaining({
      status: 'error',
      error_message: expect.stringContaining('E_CONTEXT_REQUIRED'),
    }));
    expectNoMutationDispatch();
  });

  it.each(['start', 'finish'] as const)(
    'keeps a known-action context denial fail-closed when audit %s throws',
    async (failurePoint) => {
      if (failurePoint === 'start') {
        vi.mocked(startActionLog).mockImplementationOnce(() => {
          throw new Error('audit start failed');
        });
      } else {
        vi.mocked(finishActionLog).mockImplementationOnce(() => {
          throw new Error('audit finish failed');
        });
      }

      const result = await (runAction as any)({ name: 'flush_dns' });

      expect(result.error?.code).toBe('E_CONTEXT_REQUIRED');
      expectNoMutationDispatch();
    },
  );

  // Production break caught: a renderer-controlled request can forge automatic authority.
  it('ignores context forged inside the action input', async () => {
    const result = await (runAction as any)({
      name: 'flush_dns',
      context: AUTOMATIC_INCIDENT,
    });

    expect(result.error?.code).toBe('E_CONTEXT_REQUIRED');
    expect(finishActionLog).toHaveBeenCalledWith(41, expect.objectContaining({
      status: 'error',
      error_message: expect.stringContaining('E_CONTEXT_REQUIRED'),
    }));
    expectNoMutationDispatch();
  });

  // Production break caught: an invalid mode-to-source pairing is trusted at runtime.
  it('denies malformed trusted context without rollback or script dispatch', async () => {
    const result = await (runAction as any)(
      { name: 'flush_dns' },
      { mode: 'automatic', source: 'renderer' },
    );

    expect(result.error?.code).toBe('E_CONTEXT_REQUIRED');
    expectNoMutationDispatch();
  });

  // Production break caught: automatic execution ignores the persisted global kill switch.
  it('logs and denies automatic execution while global maintenance is disabled', async () => {
    const result = await runAction({ name: 'flush_dns' }, AUTOMATIC_INCIDENT);

    expect(result.error?.code).toBe('E_AUTOMATION_DISABLED');
    expect(finishActionLog).toHaveBeenCalledWith(41, expect.objectContaining({
      status: 'error',
      error_message: expect.stringContaining('E_AUTOMATION_DISABLED'),
    }));
    expectNoMutationDispatch();
  });

  // Production break caught: high-impact automatic actions reach either script runner.
  it.each([
    ['recycle-bin', 'empty_recycle_bins'],
    ['ResetBase', 'shrink_component_store'],
    ['reboot-required', 'reset_winsock'],
    ['destructive', 'clear_temp_files'],
  ] as const)('denies the %s automatic action before mutation dispatch', async (_label, name) => {
    getSetting.mockReturnValue('1');

    const result = await runAction({ name }, AUTOMATIC_INCIDENT);

    expect(result.error?.code).toBe('E_AUTOMATION_NEVER');
    expectNoMutationDispatch();
  });

  // Production break caught: policy enforcement changes the existing manual renderer path.
  it('preserves successful manual renderer execution', async () => {
    const result = await runAction({ name: 'flush_dns' }, MANUAL_RENDERER);

    expect(result.success).toBe(true);
    expect(runPowerShellScript).toHaveBeenCalledTimes(1);
    expect(runElevatedPowerShellScript).not.toHaveBeenCalled();
  });
});

describe('runAction future automatic rollback control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it.each(['null', 'throw'] as const)(
    'fails closed when required rollback preparation returns %s',
    async (failureMode) => {
      // No current Phase 0 action is automation-eligible. This scoped module
      // substitution reaches the future-safe branch without weakening the real catalog.
      vi.doMock('../../src/shared/automationCatalog.js', async (importOriginal) => {
        const actual = await importOriginal<typeof import('../../src/shared/automationCatalog.js')>();
        return {
          ...actual,
          ACTION_AUTOMATION: {
            ...actual.ACTION_AUTOMATION,
            rebuild_search_index: {
              ...actual.ACTION_AUTOMATION.rebuild_search_index,
              automation: 'safe',
              requiresRollback: true,
            },
          },
        };
      });
      vi.doMock('../../src/main/automationPolicy.js', () => ({
        evaluateAutomationPolicy: vi.fn(() => ({ allowed: true, code: 'ALLOW' })),
      }));

      const [{ runAction: runFutureAutomatic }, rollback, runners] = await Promise.all([
        import('../../src/main/actionRunner.js'),
        import('../../src/main/rollbackManager.js'),
        import('../../src/main/scriptRunner.js'),
      ]);
      if (failureMode === 'throw') {
        vi.mocked(rollback.prepareRollback).mockRejectedValueOnce(new Error('snapshot failed'));
      } else {
        vi.mocked(rollback.prepareRollback).mockResolvedValueOnce(null);
      }

      const result = await runFutureAutomatic(
        { name: 'rebuild_search_index' },
        AUTOMATIC_INCIDENT,
      );

      expect(result.error?.code).toBe('E_ROLLBACK_UNAVAILABLE');
      expect(runners.runPowerShellScript).not.toHaveBeenCalled();
      expect(runners.runElevatedPowerShellScript).not.toHaveBeenCalled();

      vi.doUnmock('../../src/shared/automationCatalog.js');
      vi.doUnmock('../../src/main/automationPolicy.js');
    },
  );
});
