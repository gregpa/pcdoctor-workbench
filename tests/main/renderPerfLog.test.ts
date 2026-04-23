// @vitest-environment node
/**
 * Tests for src/main/renderPerfLog.ts (v2.4.38)
 *
 * Strategy: mock node:fs/promises entirely so the hardcoded
 * C:\ProgramData\PCDoctor\logs path is never touched. Each test gets a
 * fresh module import (vi.resetModules) so the module-level _dirReady
 * Promise and _droppedSinceCap counter reset between tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── fs/promises mock factory ──────────────────────────────────────────────
// We use vi.hoisted so the mock is available before any import.
const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  stat: vi.fn(async () => ({ size: 0 })),
  appendFile: vi.fn(async () => undefined),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: fsMock.mkdir,
  stat: fsMock.stat,
  appendFile: fsMock.appendFile,
}));

// Re-import the module fresh per test so module-level state is clean.
let writeRenderPerfLine: (phase: string, ms: number, extra?: Record<string, unknown>) => Promise<void>;
let getRenderPerfDroppedCount: () => number;

beforeEach(async () => {
  vi.resetModules();
  fsMock.mkdir.mockReset().mockResolvedValue(undefined);
  fsMock.stat.mockReset().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  fsMock.appendFile.mockReset().mockResolvedValue(undefined);

  const mod = await import('@main/renderPerfLog.js');
  writeRenderPerfLine = mod.writeRenderPerfLine;
  getRenderPerfDroppedCount = mod.getRenderPerfDroppedCount;
});

// ── Helpers ────────────────────────────────────────────────────────────────

function capturedLine(): Record<string, unknown> {
  const call = fsMock.appendFile.mock.calls[0];
  expect(call).toBeDefined();
  const raw = call[1] as string;
  return JSON.parse(raw.trimEnd());
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('writeRenderPerfLine: well-formed JSON line', () => {
  it('writes a line containing ts, phase, duration_ms fields', async () => {
    await writeRenderPerfLine('render', 42.5);
    const line = capturedLine();
    expect(typeof line.ts).toBe('string');
    expect(line.phase).toBe('render');
    expect(line.duration_ms).toBe(42.5);
  });

  it('rounds duration_ms to two decimal places', async () => {
    await writeRenderPerfLine('paint', 12.3456789);
    const line = capturedLine();
    // Math.round(12.3456789 * 100) / 100 = 12.35
    expect(line.duration_ms).toBe(12.35);
  });

  it('ts field is a valid ISO 8601 timestamp', async () => {
    await writeRenderPerfLine('focus', 1);
    const line = capturedLine();
    expect(new Date(line.ts as string).toISOString()).toBe(line.ts);
  });
});

describe('writeRenderPerfLine: extra fields merged at root', () => {
  it('merges extra fields into the root object (not nested under "extra")', async () => {
    await writeRenderPerfLine('resize', 7, { component: 'Dashboard', frames: 3, active: true });
    const line = capturedLine();
    expect(line.component).toBe('Dashboard');
    expect(line.frames).toBe(3);
    expect(line.active).toBe(true);
    // Must not be nested under an "extra" key
    expect(line.extra).toBeUndefined();
  });
});

describe('writeRenderPerfLine: size cap rotation (50MB)', () => {
  it('drops write and increments getRenderPerfDroppedCount when file size >= MAX_LOG_BYTES', async () => {
    const MAX = 50 * 1024 * 1024;
    fsMock.stat.mockResolvedValue({ size: MAX });

    await writeRenderPerfLine('drag', 5);

    expect(fsMock.appendFile).not.toHaveBeenCalled();
    expect(getRenderPerfDroppedCount()).toBe(1);
  });

  it('accumulates dropped count across multiple over-cap calls', async () => {
    const MAX = 50 * 1024 * 1024;
    fsMock.stat.mockResolvedValue({ size: MAX });

    await writeRenderPerfLine('drag', 1);
    await writeRenderPerfLine('drag', 2);
    await writeRenderPerfLine('drag', 3);

    expect(getRenderPerfDroppedCount()).toBe(3);
  });

  it('allows writes when file size is exactly one byte under the cap', async () => {
    const MAX = 50 * 1024 * 1024;
    fsMock.stat.mockResolvedValue({ size: MAX - 1 });

    await writeRenderPerfLine('mount', 10);

    expect(fsMock.appendFile).toHaveBeenCalledTimes(1);
    expect(getRenderPerfDroppedCount()).toBe(0);
  });
});

describe('writeRenderPerfLine: single-flight mkdir', () => {
  it('calls mkdir only once even when multiple writes are concurrent', async () => {
    // Make mkdir take a tick so concurrent calls overlap
    fsMock.mkdir.mockImplementation(() => new Promise(r => setTimeout(r, 0)));

    await Promise.all([
      writeRenderPerfLine('a', 1),
      writeRenderPerfLine('b', 2),
      writeRenderPerfLine('c', 3),
    ]);

    expect(fsMock.mkdir).toHaveBeenCalledTimes(1);
  });
});

describe('writeRenderPerfLine: never throws', () => {
  it('resolves without throwing when appendFile rejects', async () => {
    fsMock.appendFile.mockRejectedValue(new Error('disk full'));
    await expect(writeRenderPerfLine('crash', 1)).resolves.toBeUndefined();
  });

  it('resolves without throwing when mkdir rejects', async () => {
    fsMock.mkdir.mockRejectedValue(new Error('permission denied'));
    await expect(writeRenderPerfLine('crash', 1)).resolves.toBeUndefined();
  });
});
