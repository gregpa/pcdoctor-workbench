// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * notifier.ts defines `isQuietHours` as a module-private function, so we
 * can't import it directly. Instead we test the public `notify()` behavior:
 * during quiet hours, non-critical notifications are buffered to disk
 * instead of being sent. By stubbing the Date.prototype.getHours global
 * and the settings lookup we can drive the `isQuietHours` branch logic
 * deterministically.
 */

// In-memory settings store that our mock reads from. Tests mutate this.
const SETTINGS: Record<string, string | null> = {};

vi.mock('../../src/main/dataStore.js', () => ({
  getSetting: (k: string) => (k in SETTINGS ? SETTINGS[k] : null),
  hasSeenFinding: () => false,
  markFindingSeen: () => {},
}));

// Stub telegramBridge so notify() never touches the network even if it
// falls through to the non-quiet branch.
vi.mock('../../src/main/telegramBridge.js', () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
  makeCallbackData: (..._a: any[]) => 'cb',
}));

// Stub electron Notification so it's a no-op in Node tests.
vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return false; }
    constructor(_opts: any) {}
    show() {}
  },
}));

// In-memory file system substitute for the buffer file.
const FILES: Record<string, string> = {};
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn((p: string) => p in FILES),
    readFileSync: vi.fn((p: string, _enc?: any) => {
      if (p in FILES) return FILES[p];
      throw new Error(`ENOENT: ${p}`);
    }),
    writeFileSync: vi.fn((p: string, data: string, _enc?: any) => {
      FILES[p] = data;
    }),
  };
});

describe('notifier quiet-hours logic', () => {
  let originalGetHours: () => number;

  beforeEach(() => {
    for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
    for (const k of Object.keys(FILES)) delete FILES[k];
    originalGetHours = Date.prototype.getHours;
    // Enable toast so the notify() path actually buffers when quiet.
    SETTINGS['event:test_event:toast'] = '1';
    SETTINGS['telegram_enabled'] = '0';
  });

  afterEach(() => {
    Date.prototype.getHours = originalGetHours;
    vi.resetModules();
  });

  function setClock(hour: number) {
    Date.prototype.getHours = function () { return hour; };
  }

  async function loadNotify() {
    const mod = await import('../../src/main/notifier.js');
    return mod.notify;
  }

  it('start=23 end=7 (wrap across midnight) — hour 2 is quiet → buffers', async () => {
    SETTINGS['quiet_hours_start'] = '23';
    SETTINGS['quiet_hours_end'] = '7';
    setClock(2);
    const notify = await loadNotify();
    await notify({ severity: 'warning', title: 't', body: 'b', eventKey: 'test_event' });
    const bufFiles = Object.keys(FILES);
    expect(bufFiles.length).toBe(1);
    const buf = JSON.parse(FILES[bufFiles[0]]);
    expect(buf).toHaveLength(1);
    expect(buf[0].title).toBe('t');
  });

  it('start=23 end=7 — hour 10 is NOT quiet → no buffer write', async () => {
    SETTINGS['quiet_hours_start'] = '23';
    SETTINGS['quiet_hours_end'] = '7';
    setClock(10);
    const notify = await loadNotify();
    await notify({ severity: 'warning', title: 't', body: 'b', eventKey: 'test_event' });
    expect(Object.keys(FILES).length).toBe(0);
  });

  it('start=12 end=14 (simple range) — hour 13 is quiet → buffers', async () => {
    SETTINGS['quiet_hours_start'] = '12';
    SETTINGS['quiet_hours_end'] = '14';
    setClock(13);
    const notify = await loadNotify();
    await notify({ severity: 'info', title: 'lunch', body: 'b', eventKey: 'test_event' });
    SETTINGS['event:test_event:toast'] = '1'; // ensure info is toast-enabled
    const bufFiles = Object.keys(FILES);
    expect(bufFiles.length).toBe(1);
  });

  it('start=12 end=14 — hour 15 is NOT quiet → no buffer', async () => {
    SETTINGS['quiet_hours_start'] = '12';
    SETTINGS['quiet_hours_end'] = '14';
    setClock(15);
    const notify = await loadNotify();
    await notify({ severity: 'warning', title: 't', body: 'b', eventKey: 'test_event' });
    expect(Object.keys(FILES).length).toBe(0);
  });

  it('start=12 end=14 — hour 12 (boundary start) is quiet; hour 14 (boundary end) is NOT', async () => {
    SETTINGS['quiet_hours_start'] = '12';
    SETTINGS['quiet_hours_end'] = '14';
    setClock(12);
    let notify = await loadNotify();
    await notify({ severity: 'warning', title: 'at12', body: 'b', eventKey: 'test_event' });
    expect(Object.keys(FILES).length).toBe(1);

    // Reset buffer
    for (const k of Object.keys(FILES)) delete FILES[k];
    vi.resetModules();

    setClock(14);
    notify = await loadNotify();
    await notify({ severity: 'warning', title: 'at14', body: 'b', eventKey: 'test_event' });
    expect(Object.keys(FILES).length).toBe(0);
  });

  it('start === end (e.g. 0,0) — never quiet even at that hour', async () => {
    SETTINGS['quiet_hours_start'] = '0';
    SETTINGS['quiet_hours_end'] = '0';
    setClock(0);
    const notify = await loadNotify();
    await notify({ severity: 'warning', title: 't', body: 'b', eventKey: 'test_event' });
    expect(Object.keys(FILES).length).toBe(0);
  });

  it('critical severity bypasses quiet hours (does NOT buffer)', async () => {
    SETTINGS['quiet_hours_start'] = '23';
    SETTINGS['quiet_hours_end'] = '7';
    setClock(2);
    const notify = await loadNotify();
    await notify({ severity: 'critical', title: 'boom', body: 'b', eventKey: 'test_event' });
    // Critical notifications are not buffered; they go straight through.
    expect(Object.keys(FILES).length).toBe(0);
  });
});
