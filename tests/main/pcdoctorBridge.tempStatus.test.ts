// @vitest-environment node
//
// v2.5.2: tests for the _lastTempStatus singleton populated inside
// readTemperaturesCached. The exported test hooks are:
//   - getLatestTempStatus()                    -- read the singleton
//   - _resetLastTempStatusForTests()           -- clear it between tests
//   - _readTemperaturesBestEffortForTests()    -- call the inner function
//                                                 directly with a mocked
//                                                 dynamic scriptRunner import
//
// Mock strategy: vi.mock the dynamic import('./scriptRunner.js') that
// readTemperaturesBestEffort uses so no real PS spawn happens. The mock
// is registered before the module under test is imported (standard
// vitest hoisting rule).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock node:fs/promises so pcdoctorBridge's top-level imports resolve.
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    copyFile: vi.fn(async () => undefined),
    unlink: vi.fn(async () => undefined),
  };
});

// Mock the dynamic scriptRunner import that readTemperaturesBestEffort uses.
// readTemperaturesBestEffort does: const { runPowerShellScript } = await import('./scriptRunner.js')
// vitest resolves aliases, so we mock the aliased path.
vi.mock('@main/scriptRunner.js', () => ({
  runPowerShellScript: vi.fn(),
  runElevatedPowerShellScript: vi.fn(),
}));

// Stub all other heavy transitive imports that pcdoctorBridge pulls in.
vi.mock('@main/dataStore.js', () => ({
  recordStatusSnapshot: vi.fn(),
  getMetricWeekDelta: vi.fn(() => ({ week_ago: null, now: null })),
}));
vi.mock('@main/notifier.js', () => ({
  emitNewFindingNotifications: vi.fn(async () => {}),
}));
vi.mock('@main/constants.js', () => ({
  LATEST_JSON_PATH: '/fake/latest.json',
  PCDOCTOR_ROOT: '/fake/pcdoctor',
}));

import { getLatestTempStatus, _resetLastTempStatusForTests, _readTemperaturesBestEffortForTests } from '@main/pcdoctorBridge.js';
import { runPowerShellScript } from '@main/scriptRunner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal PS payload that readTemperaturesBestEffort accepts. */
function makePsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cpu: {
      source: 'LibreHardwareMonitor HTTP',
      from_cache: false,
      zones: [{ temp_c: 45 }],
    },
    gpu: [{ temp_c: 60 }],
    lhm_http_open: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getLatestTempStatus singleton (v2.5.2)', () => {
  beforeEach(() => {
    _resetLastTempStatusForTests();
    // mockReset clears both call history AND the queued implementation stack,
    // preventing stale mockResolvedValueOnce entries from bleeding into the
    // next test. (mockClear only clears call counts, not the impl queue.)
    vi.mocked(runPowerShellScript).mockReset();
  });

  it('returns null after _resetLastTempStatusForTests is called', () => {
    expect(getLatestTempStatus()).toBeNull();
  });

  it('returns the source-status fields from a successful PS payload', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload());

    const result = await _readTemperaturesBestEffortForTests();

    expect(result).not.toBeNull();
    expect(result?.source).toBe('LibreHardwareMonitor HTTP');
    expect(result?.from_cache).toBe(false);
    expect(result?.lhm_http_open).toBe(true);
  });

  it('returns cpu and gpu temperatures alongside source-status fields', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload());

    const result = await _readTemperaturesBestEffortForTests();

    expect(result?.cpu_temp_c).toBe(45);
    expect(result?.gpu_temp_c).toBe(60);
  });

  it('reflects alternative source value from PS payload', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce(makePsPayload({
      cpu: { source: 'MSAcpi_ThermalZoneTemperature', from_cache: true, zones: [{ temp_c: 55 }] },
      lhm_http_open: false,
    }));

    const r = await _readTemperaturesBestEffortForTests();
    expect(r?.source).toBe('MSAcpi_ThermalZoneTemperature');
    expect(r?.from_cache).toBe(true);
    expect(r?.lhm_http_open).toBe(false);
  });

  it('returns null when runPowerShellScript rejects, never throws', async () => {
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(new Error('PS spawn failed'));

    await expect(_readTemperaturesBestEffortForTests()).resolves.toBeNull();
  });

  it('null return from the inner function preserves the prior singleton value (null-guard)', async () => {
    // The _lastTempStatus singleton is only updated inside readTemperaturesCached
    // when the inner function returns a non-null value:
    //   if (v) { _lastTempStatus = { source: v.source, ... } }
    // When the inner function returns null (PS spawn failed), the singleton
    // keeps its prior value. Here the prior value is null (fresh reset),
    // so getLatestTempStatus() should still be null after a null return.
    vi.mocked(runPowerShellScript).mockRejectedValueOnce(new Error('timeout'));

    const result = await _readTemperaturesBestEffortForTests();
    expect(result).toBeNull();
    // Singleton was never written (no successful call since last reset).
    expect(getLatestTempStatus()).toBeNull();
  });

  it('source defaults to "none" when cpu.source is missing from PS payload', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce({
      cpu: { zones: [] },
      gpu: [],
      lhm_http_open: false,
    });
    const r = await _readTemperaturesBestEffortForTests();
    expect(r?.source).toBe('none');
    expect(r?.from_cache).toBe(false);
    expect(r?.lhm_http_open).toBe(false);
  });

  it('lhm_http_open defaults to false when the field is absent from PS payload', async () => {
    vi.mocked(runPowerShellScript).mockResolvedValueOnce({
      cpu: { source: 'LibreHardwareMonitor HTTP', from_cache: false, zones: [] },
      gpu: [],
      // lhm_http_open intentionally omitted
    });
    const r = await _readTemperaturesBestEffortForTests();
    expect(r?.lhm_http_open).toBe(false);
  });
});
