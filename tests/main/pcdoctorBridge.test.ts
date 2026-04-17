import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { readFile as realReadFile } from 'node:fs/promises';

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

// Import AFTER vi.mock so the module under test sees the mocked readFile.
import { readFile } from 'node:fs/promises';
import { getStatus } from '../../src/main/pcdoctorBridge.js';

// Resolve fixture path without relying on __dirname (ESM-safe)
const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'latest.sample.json');

describe('pcdoctorBridge.getStatus', () => {
  it('returns a SystemStatus when latest.json exists', async () => {
    const fixture = await realReadFile(fixturePath, 'utf8');
    (readFile as any).mockResolvedValueOnce(fixture);

    const status = await getStatus();
    expect(status.overall_severity).toBe('warn');
    expect(status.kpis.length).toBeGreaterThanOrEqual(6);
    expect(status.gauges.length).toBeGreaterThanOrEqual(3);
    expect(status.host).toBe('Alienware Aurora R11');

    const cpuKpi = status.kpis.find((k) => k.label.includes('CPU'));
    expect(cpuKpi?.value).toBe(82);
    expect(cpuKpi?.severity).toBe('warn');
  });

  it('throws E_BRIDGE_FILE_MISSING when latest.json absent', async () => {
    (readFile as any).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(getStatus()).rejects.toMatchObject({ code: 'E_BRIDGE_FILE_MISSING' });
  });

  it('throws E_BRIDGE_PARSE_FAILED on corrupt JSON', async () => {
    (readFile as any).mockResolvedValueOnce('not json');
    await expect(getStatus()).rejects.toMatchObject({ code: 'E_BRIDGE_PARSE_FAILED' });
  });
});
