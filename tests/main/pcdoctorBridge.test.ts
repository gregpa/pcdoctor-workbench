// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { readFile as realReadFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Import AFTER vi.mock so the module under test sees the mocked readFile.
import { readFile } from 'node:fs/promises';
import { getStatus, mapAreaToAction, _resetStatusCacheForTests } from '../../src/main/pcdoctorBridge.js';

// Resolve fixture path without relying on __dirname (ESM-safe)
const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'latest.sample.json');

describe('pcdoctorBridge.getStatus', () => {
  beforeEach(() => {
    // v2.4.40: reset module-level cache so tests don't bleed through
    // the 2-second STATUS_CACHE_MS window.
    _resetStatusCacheForTests();
    // mockClear, not mockReset -- mockReset wipes the default pass-through
    // implementation set by `vi.fn(actual.readFile)`, which breaks
    // realReadFile() at the top of each test (would return undefined).
    (readFile as any).mockClear();
  });

  it('maps real latest.json schema to SystemStatus', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');
    (readFile as any).mockResolvedValueOnce(fixture);

    const status = await getStatus();
    expect(status.host).toBe('ALIENWARE-R11');
    expect(status.overall_severity).toBe('warn');
    expect(status.overall_label).toContain('ATTENTION');
    expect(status.generated_at).toBeGreaterThan(1_700_000_000);

    const cpu = status.kpis.find((k) => k.label === 'CPU Load');
    expect(cpu?.value).toBe(32);
    expect(cpu?.severity).toBe('good');

    const ram = status.kpis.find((k) => k.label === 'RAM Usage');
    expect(ram?.value).toBe(88);
    expect(ram?.severity).toBe('warn');

    const cDisk = status.kpis.find((k) => k.label === 'C: Drive Free');
    expect(cDisk?.value).toBe(19);
    expect(cDisk?.severity).toBe('warn');

    expect(status.gauges.length).toBeGreaterThanOrEqual(3);
  });

  it('throws E_BRIDGE_FILE_MISSING when latest.json absent', async () => {
    (readFile as any).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(getStatus()).rejects.toMatchObject({ code: 'E_BRIDGE_FILE_MISSING' });
  });

  it('throws E_BRIDGE_PARSE_FAILED on corrupt JSON', async () => {
    (readFile as any).mockResolvedValueOnce('not json');
    await expect(getStatus()).rejects.toMatchObject({ code: 'E_BRIDGE_PARSE_FAILED' });
  });

  it('strips UTF-8 BOM from latest.json before parsing', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');
    // Prepend BOM to simulate PowerShell-written file
    (readFile as any).mockResolvedValueOnce('\uFEFF' + fixture);

    const status = await getStatus();
    expect(status.overall_severity).toBe('warn');
    expect(status.host).toBe('ALIENWARE-R11');
  });
});

/**
 * v2.4.40: resize-freeze fix (B51). Multiple concurrent getStatus callers
 * were independently hitting readFile, and when latest.json was locked by
 * Defender / OneDrive / in-flight scanner, they all queued up and blocked
 * for ~49 seconds. Three protections added:
 *   1. 2-second STATUS_CACHE_MS -- repeated callers share parsed status
 *   2. _getStatusInFlight -- concurrent callers share one Promise
 *   3. 3-second readFile timeout -- fail fast; fall back to cached last-good
 *
 * If any of these tests goes red, one of the three protections was removed
 * from src/main/pcdoctorBridge.ts -- see the FIX block at top of getStatus.
 */
describe('pcdoctorBridge.getStatus resize-freeze fix (v2.4.40)', () => {
  beforeEach(() => {
    _resetStatusCacheForTests();
    // mockClear, not mockReset -- mockReset wipes the default pass-through
    // implementation set by `vi.fn(actual.readFile)`, which breaks
    // realReadFile() at the top of each test (would return undefined).
    (readFile as any).mockClear();
  });

  it('repeated call within 2s uses cache (readFile called once)', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');
    // Clear AFTER reading the fixture -- realReadFile itself is the mocked
    // readFile (vi.mock replaces the whole module). Its call counts toward
    // toHaveBeenCalledTimes; clear so the test-relevant count starts at 0.
    (readFile as any).mockClear();
    (readFile as any).mockResolvedValue(fixture);

    await getStatus();
    await getStatus();
    await getStatus();

    // Only one actual disk read despite three callers.
    expect((readFile as any)).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share a single in-flight readFile (single-flight)', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');
    (readFile as any).mockClear();
    // Delay the read so two callers pile up while the first is pending.
    let resolveRead: (v: string) => void = () => {};
    (readFile as any).mockReturnValueOnce(new Promise<string>((resolve) => {
      resolveRead = resolve;
    }));

    const pA = getStatus();
    const pB = getStatus();
    const pC = getStatus();

    // All three should be waiting on the single in-flight read.
    expect((readFile as any)).toHaveBeenCalledTimes(1);

    resolveRead(fixture);
    const [a, b, c] = await Promise.all([pA, pB, pC]);
    // All three resolve to the same data.
    expect(a.host).toBe('ALIENWARE-R11');
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('times out readFile after 3s and falls back to cached last-good status', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');

    // Seed the cache with a successful first call.
    (readFile as any).mockResolvedValueOnce(fixture);
    const first = await getStatus();
    expect(first.host).toBe('ALIENWARE-R11');

    // Force cache miss by sleeping past 2s ... but that's slow. Instead
    // reset the IN-FLIGHT Promise only; keep the cache alive for fallback.
    // Actually cleaner: reach past the 2s window via fake timers, so the
    // next call goes through readFile which we simulate as stuck.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // Advance Date.now() past STATUS_CACHE_MS (2000) to force fresh fetch.
    vi.setSystemTime(Date.now() + 3_000);

    // Next readFile: never resolves (simulates file lock). AbortController
    // inside readFileWithTimeout should abort after 3s, triggering the
    // cache fallback.
    (readFile as any).mockImplementationOnce((_path: string, opts: any) => {
      return new Promise<string>((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            reject(err);
          });
        }
      });
    });

    const pending = getStatus();
    // Advance past the 3-second readFile timeout.
    await vi.advanceTimersByTimeAsync(3_100);
    const fallback = await pending;

    // Falls back to cached last-good status instead of throwing.
    expect(fallback.host).toBe('ALIENWARE-R11');

    vi.useRealTimers();
  });

  it('propagates ENOENT (no cache fallback for missing-file errors)', async () => {
    // Clean state, no prior cache.
    (readFile as any).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(getStatus()).rejects.toMatchObject({ code: 'E_BRIDGE_FILE_MISSING' });
  });

  it('throws timeout error when no cache exists and read times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    (readFile as any).mockImplementationOnce((_path: string, opts: any) => {
      return new Promise<string>((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const err: any = new Error('aborted');
            err.name = 'AbortError';
            err.code = 'ABORT_ERR';
            reject(err);
          });
        }
      });
    });

    const pending = getStatus();
    // Attach a no-op handler synchronously so Node doesn't briefly
    // flag the rejection as unhandled before vitest's expect catches it.
    pending.catch(() => { /* handled by expect below */ });
    await vi.advanceTimersByTimeAsync(3_100);

    // No cache seeded → timeout should bubble up as an error.
    await expect(pending).rejects.toMatchObject({ code: 'E_BRIDGE_READ_TIMEOUT' });

    vi.useRealTimers();
  });
});

/**
 * v2.4.35: mapAreaToAction was widened from (area) to (finding) so the Reboot
 * case could gate on detail.flags. PendingFileRename is the only flag with a
 * one-click fix; CBS / WU require a real reboot. These tests lock in:
 *   1. Reboot + PendingFileRename -> clear_stale_pending_renames
 *   2. Reboot + CBS/WU only -> undefined (no misleading button)
 *   3. Existing area mappings still work
 */
describe('mapAreaToAction (v2.4.35 widened signature)', () => {
  it('Reboot with PendingFileRename flag -> clear_stale_pending_renames', () => {
    expect(mapAreaToAction({
      area: 'Reboot',
      detail: { flags: ['PendingFileRename'], uptime_hours: 18.4 },
    })).toBe('clear_stale_pending_renames');
  });

  it('Reboot with PendingFileRename alongside others still suggests the action', () => {
    expect(mapAreaToAction({
      area: 'Reboot',
      detail: { flags: ['CBS', 'PendingFileRename'], uptime_hours: 50 },
    })).toBe('clear_stale_pending_renames');
  });

  it('Reboot with CBS only -> undefined (no one-click fix, real reboot needed)', () => {
    expect(mapAreaToAction({
      area: 'Reboot',
      detail: { flags: ['CBS'], uptime_hours: 200 },
    })).toBeUndefined();
  });

  it('Reboot with WU only -> undefined', () => {
    expect(mapAreaToAction({
      area: 'Reboot',
      detail: { flags: ['WU'], uptime_hours: 30 },
    })).toBeUndefined();
  });

  it('Reboot with malformed or missing detail -> undefined', () => {
    expect(mapAreaToAction({ area: 'Reboot' })).toBeUndefined();
    expect(mapAreaToAction({ area: 'Reboot', detail: null })).toBeUndefined();
    expect(mapAreaToAction({ area: 'Reboot', detail: {} })).toBeUndefined();
    expect(mapAreaToAction({ area: 'Reboot', detail: { flags: 'not-an-array' } })).toBeUndefined();
  });

  it('existing area -> action mappings still resolve', () => {
    expect(mapAreaToAction({ area: 'Memory' })).toBe('apply_wsl_cap');
    expect(mapAreaToAction({ area: 'DNS' })).toBe('flush_dns');
    expect(mapAreaToAction({ area: 'NAS' })).toBe('remap_nas');
  });

  it('unknown area -> undefined', () => {
    expect(mapAreaToAction({ area: 'Nonsense' })).toBeUndefined();
    expect(mapAreaToAction({})).toBeUndefined();
  });
});
