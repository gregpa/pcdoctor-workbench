// @vitest-environment node
//
// v2.4.51 (B51-ENG-1): autopilot tick in-flight guard. Pre-2.4.51 a long
// IPC sub-call (Telegram, getStatus) could overrun the 60s interval and the
// next setInterval tick fired concurrently with the still-running prior
// tick. Now: a guard skips overlapping ticks and logs a warning.
//
// IMPLEMENTATION NOTE — TEST STRATEGY (v2.4.51 polish):
// The naive approach `vi.spyOn(engine, 'evaluateAutopilot')` does NOT work
// because `tick` references `evaluateAutopilot` via closure inside the same
// ES module — the spy on the module namespace is bypassed by the internal
// closure reference. Instead we drive the guard via a CONTROLLED
// `getStatus` mock (pcdoctorBridge.js): we seed a single threshold rule so
// `evaluateAutopilot` proceeds to `await loadStatus()` → `await getStatus()`
// — and we count the real getStatus invocations, gating each one with a
// manually-resolved Promise. Two overlapping ticks within the in-flight
// window must collapse to ONE getStatus call.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let getStatusCallCount = 0;
let pendingStatusResolve: ((v: unknown) => void) | null = null;

const seedRule = {
  id: 'remove_feature_update_leftovers_low_disk',
  tier: 1,
  description: 'test seed',
  enabled: 1,
  trigger: 'threshold',
  cadence: null,
  action_name: null,
  alert_json: null,
  suppressed_until: null,
};

vi.mock('../../src/main/dataStore.js', () => ({
  seedDefaultRulesOnce: () => {},
  upsertAutopilotRule: () => {},
  listAutopilotRules: () => [seedRule],
  insertAutopilotActivity: () => 1,
  listAutopilotActivity: () => [],
  getLastAutopilotActivity: () => null,
  countAutopilotFailuresSinceSuccess: () => 0,
  queryMetricTrend: () => [],
  deleteAutopilotRule: () => {},
  getAlertEmitHistory: () => null,
  recordAlertEmit: () => {},
}));

vi.mock('../../src/main/pcdoctorBridge.js', () => ({
  getStatus: vi.fn(() => {
    getStatusCallCount++;
    return new Promise(resolve => {
      pendingStatusResolve = resolve;
    });
  }),
}));

vi.mock('../../src/main/actionRunner.js', () => ({
  runAction: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('../../src/main/telegramBridge.js', () => ({
  sendTelegramMessage: vi.fn().mockResolvedValue({ ok: true }),
  makeCallbackData: () => 'cb',
}));

describe('startAutopilotEngine tick in-flight guard (v2.4.51 B51-ENG-1)', () => {
  let engine: typeof import('../../src/main/autopilotEngine.js');

  beforeEach(async () => {
    vi.resetModules();
    getStatusCallCount = 0;
    pendingStatusResolve = null;
    engine = await import('../../src/main/autopilotEngine.js');
  });

  afterEach(() => {
    engine.stopAutopilotEngine();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('case 1+2: second tick while first in flight is skipped (only 1 getStatus call)', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    engine.startAutopilotEngine(60_000);

    // Advance past the 15s initial delay so the first tick fires. The first
    // tick calls evaluateAutopilot → loadStatus → getStatus (which blocks
    // on our pending promise). One call observed.
    await vi.advanceTimersByTimeAsync(15_001);
    expect(getStatusCallCount).toBe(1);
    expect(pendingStatusResolve).not.toBeNull();

    // Now advance the 60s interval. The first tick is still pending —
    // pendingStatusResolve hasn't been called. The guard should skip the
    // second tick and log the warning. getStatus stays at 1.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(getStatusCallCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('tick skipped: prior tick still in flight'),
    );

    // Resolve the first tick's getStatus → tick continues, evaluation
    // returns no decisions for our seed (the pure rule never matches a
    // null-ish status), tickInFlight clears in finally.
    pendingStatusResolve!(null);
    await vi.advanceTimersByTimeAsync(0);

    // Next interval — guard releases, second tick proceeds and a fresh
    // getStatus call is observed.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(getStatusCallCount).toBe(2);

    warnSpy.mockRestore();
  });

  it('case 3: a tick whose evaluateAutopilot rejects still releases the guard for the next tick', async () => {
    vi.useFakeTimers();

    // Make getStatus reject the FIRST time (causing loadStatus to swallow
    // and return null) — actually that's a soft path. Instead, make
    // getStatus throw synchronously the first time so the in-flight try
    // catch swallows the error and the finally still resets the guard.
    const { getStatus } = await import('../../src/main/pcdoctorBridge.js');
    let calls = 0;
    (getStatus as any).mockImplementation(() => {
      calls++;
      if (calls === 1) return Promise.reject(new Error('boom'));
      return Promise.resolve(null);
    });

    engine.startAutopilotEngine(60_000);

    // First tick: getStatus rejects → loadStatus catches → returns null →
    // evaluateAutopilot returns [] → finally releases guard. Should
    // count as 1 call.
    await vi.advanceTimersByTimeAsync(15_001);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);

    // Next interval — guard released, second tick proceeds.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(calls).toBe(2);
  });
});
