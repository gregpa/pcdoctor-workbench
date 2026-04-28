// @vitest-environment node
//
// v2.5.1 (B51-DIGEST-1): tests for the digest-dedup gate in
// flushBufferedNotifications.
//
// Pre-2.5.1, three identical overnight digests landed the same morning
// (08:00 / 08:09 / 08:45 with identical internal 02:00:32 timestamp and
// identical 344-event count). Root cause: send-then-clear with a
// silently-failing saveBuffer — saveBuffer wrapped writeFileSync in
// `catch {}`, so a file lock or AV interference left the buffer populated
// and the next caller (manual "Flush Buffer Now" button OR a post-restart
// hourly tick) reloaded and re-sent it.
//
// Fix is belt-and-braces:
//   (a) last_digest_iso_date dedup gate (skip if today's already sent)
//   (b) clear buffer FIRST, send second (and abort if clear fails)
//   (c) saveBuffer returns boolean so the failure is visible
//
// These tests lock in all three contracts.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { PCDOCTOR_ROOT } from '../../src/main/constants.js';

const BUFFER_PATH = path.join(PCDOCTOR_ROOT, 'notifications-buffer.json');

const SETTINGS: Record<string, string | null> = {};
const FILES: Record<string, string> = {};
const sendTelegramMock = vi.fn(async (_text: string) => ({ ok: true }));

vi.mock('../../src/main/dataStore.js', () => ({
  getSetting: (k: string) => (k in SETTINGS ? SETTINGS[k] : null),
  setSetting: (k: string, v: string) => { SETTINGS[k] = v; },
  hasSeenFinding: () => false,
  markFindingSeen: () => {},
}));

vi.mock('../../src/main/telegramBridge.js', () => ({
  sendTelegramMessage: sendTelegramMock,
  makeCallbackData: (..._a: unknown[]) => 'cb',
}));

vi.mock('electron', () => ({
  Notification: class {
    static isSupported() { return false; }
    constructor(_opts: any) {}
    show() {}
  },
}));

// Track whether writeFileSync should fail (simulates AV / file lock).
let writeShouldFail = false;
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
      if (writeShouldFail) throw new Error('EBUSY: file locked');
      FILES[p] = data;
    }),
  };
});

async function loadFlush() {
  const mod = await import('../../src/main/notifier.js');
  return mod.flushBufferedNotifications;
}

function seedBuffer(entries: Array<{ ts: number; severity: 'warning' | 'critical' | 'info'; title: string; body: string; eventKey: string }>) {
  FILES[BUFFER_PATH] = JSON.stringify(entries);
}

describe('flushBufferedNotifications dedup gate (v2.5.1 B51-DIGEST-1)', () => {
  beforeEach(() => {
    for (const k of Object.keys(SETTINGS)) delete SETTINGS[k];
    for (const k of Object.keys(FILES)) delete FILES[k];
    sendTelegramMock.mockClear();
    sendTelegramMock.mockResolvedValue({ ok: true });
    writeShouldFail = false;
    SETTINGS['telegram_enabled'] = '1';
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('case 1: empty buffer → returns sent:0, no Telegram call, no setting write', async () => {
    const flush = await loadFlush();
    const r = await flush();
    expect(r.sent).toBe(0);
    expect(sendTelegramMock).not.toHaveBeenCalled();
    expect(SETTINGS['last_digest_iso_date']).toBeUndefined();
  });

  it('case 2: populated buffer, first call today → sends Telegram, sets last_digest_iso_date, clears buffer', async () => {
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 'EventLog', body: 'x', eventKey: 'eventlog_recurring' }]);
    const r = await flush();
    expect(r.sent).toBe(1);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(SETTINGS['last_digest_iso_date']).toBe(new Date().toISOString().slice(0, 10));
    // Buffer file is now an empty array.
    const path = Object.keys(FILES)[0];
    expect(JSON.parse(FILES[path])).toEqual([]);
  });

  it('case 3: second call same day with NEW buffer entries → still skipped (THE bug fix)', async () => {
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 'first', body: 'x', eventKey: 'k' }]);
    await flush();
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);

    // Simulate a re-buffer between flushes (same day) — e.g. a mid-day
    // quiet-hours window or a manual "Flush Buffer Now" click.
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 'second', body: 'y', eventKey: 'k' }]);
    const r = await flush();
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe('already_sent_today');
    expect(sendTelegramMock).toHaveBeenCalledTimes(1); // still 1
  });

  it('case 4: next-day call after dedup gate fired → resets and sends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-28T08:00:00Z'));
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't1', body: 'x', eventKey: 'k' }]);
    await flush();
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(SETTINGS['last_digest_iso_date']).toBe('2026-04-28');

    // Advance to next day.
    vi.setSystemTime(new Date('2026-04-29T08:00:00Z'));
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't2', body: 'y', eventKey: 'k' }]);
    const r = await flush();
    expect(r.sent).toBe(1);
    expect(sendTelegramMock).toHaveBeenCalledTimes(2);
    expect(SETTINGS['last_digest_iso_date']).toBe('2026-04-29');
  });

  it('case 5: saveBuffer fails (file locked) → does NOT send, returns buffer_clear_failed (no re-send loop)', async () => {
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't', body: 'x', eventKey: 'k' }]);
    writeShouldFail = true;
    const r = await flush();
    expect(r.sent).toBe(0);
    expect(r.skipped).toBe('buffer_clear_failed');
    expect(sendTelegramMock).not.toHaveBeenCalled();
    expect(SETTINGS['last_digest_iso_date']).toBeUndefined();
  });

  it('case 6: setting written BEFORE Telegram call (Telegram throw must not unwind dedup marker)', async () => {
    sendTelegramMock.mockRejectedValueOnce(new Error('network down'));
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't', body: 'x', eventKey: 'k' }]);
    await expect(flush()).rejects.toThrow(/network down/);
    // Even though Telegram threw, the dedup marker is set — losing one
    // digest beats sending three. The buffer is also cleared.
    expect(SETTINGS['last_digest_iso_date']).toBe(new Date().toISOString().slice(0, 10));
    const path = Object.keys(FILES)[0];
    expect(JSON.parse(FILES[path])).toEqual([]);
  });

  it('case 7: telegram_enabled=0 → still respects dedup gate (no resend loop just because Telegram is off)', async () => {
    SETTINGS['telegram_enabled'] = '0';
    const flush = await loadFlush();
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't', body: 'x', eventKey: 'k' }]);
    const r1 = await flush();
    expect(r1.sent).toBe(1);
    expect(sendTelegramMock).not.toHaveBeenCalled();
    expect(SETTINGS['last_digest_iso_date']).toBe(new Date().toISOString().slice(0, 10));
    // Second call same day with new entries → skipped.
    seedBuffer([{ ts: Date.now(), severity: 'warning', title: 't2', body: 'y', eventKey: 'k' }]);
    const r2 = await flush();
    expect(r2.skipped).toBe('already_sent_today');
  });
});
