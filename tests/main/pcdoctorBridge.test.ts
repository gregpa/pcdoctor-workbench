// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { readFile as realReadFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Import AFTER vi.mock so the module under test sees the mocked readFile.
import { readFile } from 'node:fs/promises';
import { getStatus, mapAreaToAction } from '../../src/main/pcdoctorBridge.js';

// Resolve fixture path without relying on __dirname (ESM-safe)
const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'latest.sample.json');

describe('pcdoctorBridge.getStatus', () => {
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
