/**
 * Tests for src/renderer/lib/perfLog.ts (v2.4.38)
 *
 * Covers: per-phase throttle (100ms MIN_LOG_INTERVAL_MS), dropped_since_last
 * counter, cross-phase independence, markPerf stopwatch, and no-op when
 * window.api.logRenderPerf is undefined.
 *
 * Environment: jsdom (default for this project's vitest config).
 *
 * State isolation: perfLog.ts uses module-level Maps for throttle state.
 * We reset them between tests by re-importing the module fresh via
 * vi.resetModules() in beforeEach so each test gets a clean slate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// performance.now() is available in jsdom. We fake it so tests don't depend
// on wall-clock timing.
let _now = 0;
vi.stubGlobal('performance', { now: () => _now });

// We need a fresh module import per test to clear the module-level Maps.
// We achieve this with vi.resetModules() + dynamic import in beforeEach.
let logPerf: (phase: string, durationMs: number, extra?: Record<string, string | number | boolean>) => void;
let markPerf: (phase: string) => (extra?: Record<string, string | number | boolean>) => void;
let mockLogRenderPerf: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  _now = 0;

  mockLogRenderPerf = vi.fn();
  // Provide window.api.logRenderPerf so logPerf can reach it.
  (global as any).window = {
    api: { logRenderPerf: mockLogRenderPerf },
  };

  const mod = await import('@renderer/lib/perfLog.js');
  logPerf = mod.logPerf;
  markPerf = mod.markPerf;
});

describe('logPerf throttle: first call always emits', () => {
  it('emits on first call for a brand-new phase', () => {
    logPerf('render', 10);
    expect(mockLogRenderPerf).toHaveBeenCalledTimes(1);
    expect(mockLogRenderPerf).toHaveBeenCalledWith('render', 10, {});
  });
});

describe('logPerf throttle: call within 100ms is suppressed', () => {
  it('does not call window.api.logRenderPerf when called again before 100ms elapses', () => {
    _now = 0;
    logPerf('resize', 5);
    mockLogRenderPerf.mockClear();

    _now = 99; // 99ms later, still within the window
    logPerf('resize', 6);
    expect(mockLogRenderPerf).not.toHaveBeenCalled();
  });
});

describe('logPerf throttle: call after 100ms emits with dropped_since_last', () => {
  it('emits and includes dropped_since_last equal to the number of throttled calls', () => {
    _now = 0;
    logPerf('mount', 20); // first: emits, no dropped
    mockLogRenderPerf.mockClear();

    _now = 50;
    logPerf('mount', 21); // throttled: dropped count becomes 1
    _now = 80;
    logPerf('mount', 22); // throttled: dropped count becomes 2

    expect(mockLogRenderPerf).not.toHaveBeenCalled();

    _now = 150; // 150ms past the first emit -- window expired
    logPerf('mount', 23);

    expect(mockLogRenderPerf).toHaveBeenCalledTimes(1);
    const [, , payload] = mockLogRenderPerf.mock.calls[0];
    expect(payload.dropped_since_last).toBe(2);
  });

  it('resets dropped_since_last to 0 after emitting, so the next throttled+emitted call reports fresh count', () => {
    _now = 0;
    logPerf('focus', 1);
    _now = 50;
    logPerf('focus', 2); // throttled

    _now = 110;
    logPerf('focus', 3); // emits with dropped_since_last=1
    mockLogRenderPerf.mockClear();

    // No more drops before the next emit
    _now = 220;
    logPerf('focus', 4); // emits with dropped_since_last=0 (no payload key)
    const [, , payload] = mockLogRenderPerf.mock.calls[0];
    expect(payload.dropped_since_last).toBeUndefined();
  });
});

describe('logPerf throttle: different phases do not interfere', () => {
  it('allows two distinct phases to both emit within the same 100ms window', () => {
    _now = 0;
    logPerf('phaseA', 1);
    logPerf('phaseB', 2);
    // Both should have emitted because they are distinct phases
    expect(mockLogRenderPerf).toHaveBeenCalledTimes(2);
    const phases = mockLogRenderPerf.mock.calls.map(c => c[0]);
    expect(phases).toContain('phaseA');
    expect(phases).toContain('phaseB');
  });

  it('throttling phaseA does not throttle phaseB', () => {
    _now = 0;
    logPerf('phaseA', 1);
    _now = 50;
    logPerf('phaseA', 2); // throttled
    logPerf('phaseB', 3); // should still emit (different phase)

    const calls = mockLogRenderPerf.mock.calls.map(c => c[0]);
    expect(calls.filter(p => p === 'phaseA')).toHaveLength(1);
    expect(calls.filter(p => p === 'phaseB')).toHaveLength(1);
  });
});

describe('markPerf stopwatch', () => {
  it('returns a function that emits with elapsed time when called', () => {
    _now = 100;
    const end = markPerf('drag');
    _now = 250;
    end();

    expect(mockLogRenderPerf).toHaveBeenCalledTimes(1);
    const [phase, durationMs] = mockLogRenderPerf.mock.calls[0];
    expect(phase).toBe('drag');
    // elapsed = 250 - 100 = 150ms
    expect(durationMs).toBeCloseTo(150, 5);
  });

  it('passes extra fields through to logPerf when supplied to end()', () => {
    _now = 0;
    const end = markPerf('paint');
    _now = 30;
    end({ component: 'Dashboard', frames: 2 });

    expect(mockLogRenderPerf).toHaveBeenCalledTimes(1);
    const [, , payload] = mockLogRenderPerf.mock.calls[0];
    expect(payload.component).toBe('Dashboard');
    expect(payload.frames).toBe(2);
  });
});

describe('logPerf: no-op when window.api.logRenderPerf is undefined', () => {
  it('does not throw when logRenderPerf is missing from the preload api', async () => {
    vi.resetModules();
    _now = 0;
    (global as any).window = { api: {} }; // logRenderPerf absent

    const mod = await import('@renderer/lib/perfLog.js');
    expect(() => mod.logPerf('boot', 5)).not.toThrow();
  });

  it('does not throw when window.api is entirely absent', async () => {
    vi.resetModules();
    _now = 0;
    (global as any).window = {};

    const mod = await import('@renderer/lib/perfLog.js');
    expect(() => mod.logPerf('boot', 5)).not.toThrow();
  });
});
