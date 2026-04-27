// @vitest-environment node
//
// v2.4.49 (B49-NOTIF-1): tests for dispatchAlert's same-state dedup gate.
//
// Despite the file name (kept to match the brief), the dedup logic actually
// lives in autopilotEngine.ts:dispatchAlert — notifier.ts is unchanged.
// Pre-2.4.49 dispatchAlert had no dedup; Greg's box received the same
// "Repeated action failures" Telegram alert at 03:42 AND 09:42 the same
// day. The new gate suppresses identical (rule_id, event_key, signature)
// emissions within a 24h window. Severity escalation and changed-reason
// alerts still fire because the signature differs.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory mocks for dataStore: dispatchAlert calls
// getAlertEmitHistory / recordAlertEmit / insertAutopilotActivity, plus
// the upstream listAutopilotRules / getLastAutopilotActivity / etc. We
// only stub what's reached on the Tier-3 alert path.

interface AlertHistoryEntry { last_ts: number; last_state_signature: string; }
const ALERT_HISTORY = new Map<string, AlertHistoryEntry>();
const ACTIVITY: Array<Record<string, unknown>> = [];

const sendTelegramMock = vi.fn(async (_body: string, _buttons?: unknown) => ({ ok: true }));

vi.mock('../../src/main/dataStore.js', () => ({
  upsertAutopilotRule: vi.fn(),
  listAutopilotRules: vi.fn(() => []),
  insertAutopilotActivity: vi.fn((row: Record<string, unknown>) => {
    ACTIVITY.push(row);
    return ACTIVITY.length;
  }),
  listAutopilotActivity: vi.fn(() => []),
  getLastAutopilotActivity: vi.fn(() => null), // disable upstream rate-limit
  countAutopilotFailuresSinceSuccess: vi.fn(() => 0),
  countAutopilotFailuresInWindow: vi.fn(() => 0),
  queryMetricTrend: vi.fn(() => []),
  deleteAutopilotRule: vi.fn(),
  getAlertEmitHistory: vi.fn((ruleId: string, eventKey: string) => {
    const v = ALERT_HISTORY.get(`${ruleId}|${eventKey}`);
    return v ? { rule_id: ruleId, event_key: eventKey, ...v } : null;
  }),
  recordAlertEmit: vi.fn((ruleId: string, eventKey: string, ts: number, sig: string) => {
    ALERT_HISTORY.set(`${ruleId}|${eventKey}`, { last_ts: ts, last_state_signature: sig });
  }),
}));

vi.mock('../../src/main/telegramBridge.js', () => ({
  sendTelegramMessage: sendTelegramMock,
  makeCallbackData: (..._a: unknown[]) => 'cb',
}));

// Block actionRunner / pcdoctorBridge from being touched (Tier-3 path
// shouldn't reach them, but the imports run at module load time).
vi.mock('../../src/main/actionRunner.js', () => ({
  runAction: vi.fn(),
}));
vi.mock('../../src/main/pcdoctorBridge.js', () => ({
  getStatus: vi.fn(),
}));

import type { AutopilotDecision } from '../../src/main/autopilotEngine.js';

async function loadDispatch() {
  const mod = await import('../../src/main/autopilotEngine.js');
  return mod.dispatchDecision;
}

function makeDecision(overrides: Partial<AutopilotDecision> = {}): AutopilotDecision {
  return {
    rule_id: 'alert_action_repeated_failures',
    tier: 3,
    description: 'test',
    alert: { title: 'Repeated action failures', severity: 'important', fix_actions: [] },
    reason: 'run_smart_check failed 3+ times in 7 days',
    ...overrides,
  };
}

describe('dispatchAlert dedup gate (v2.4.49 B49-NOTIF-1)', () => {
  beforeEach(() => {
    ALERT_HISTORY.clear();
    ACTIVITY.length = 0;
    sendTelegramMock.mockClear();
    sendTelegramMock.mockResolvedValue({ ok: true });
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('case 1: first emission of a Tier-3 decision → sendTelegramMessage called once; recordAlertEmit called once', async () => {
    const dispatch = await loadDispatch();
    await dispatch(makeDecision(), 0); // minGapMs=0 disables upstream rate-limit
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(ALERT_HISTORY.size).toBe(1);
  });

  it('case 2: second emission <24h later, same signature → sendTelegramMessage NOT called', async () => {
    const dispatch = await loadDispatch();
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    expect(ACTIVITY.length).toBe(1); // first dispatch wrote one 'alerted' row
    // Second call: same decision, same signature. Should be suppressed.
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1); // still 1
    // v2.4.49 polish (code-review W2): assert no phantom activity row written
    // on the dedup-skip path. Without this assertion, a future edit that
    // moves the dedup `return` AFTER `insertAutopilotActivity` would still
    // pass case 2 — the test would only verify Telegram silence, not
    // activity-log silence. The dedup gate's invariant is BOTH: no Telegram
    // call AND no activity row.
    expect(ACTIVITY.length).toBe(1);
  });

  it('case 3: second emission >24h later, same signature → sendTelegramMessage called', async () => {
    vi.useFakeTimers();
    const t0 = new Date('2026-04-26T03:42:00Z').getTime();
    vi.setSystemTime(t0);
    const dispatch = await loadDispatch();
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    // Advance >24h
    vi.setSystemTime(t0 + 25 * 60 * 60 * 1000);
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(2);
  });

  it('case 4: second emission within 24h with CHANGED signature (severity escalation) → sendTelegramMessage called', async () => {
    const dispatch = await loadDispatch();
    await dispatch(makeDecision({ alert: { title: 'Defender definitions stale (>48h)', severity: 'important', fix_actions: [] } }), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    // Now same rule_id, same eventKey, but escalated severity → different signature → fires.
    await dispatch(makeDecision({
      rule_id: 'alert_action_repeated_failures',
      alert: { title: 'Defender definitions stale (>48h)', severity: 'critical', fix_actions: [] },
    }), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(2);
  });

  it('case 5: sendTelegramMessage returns {ok:false} → recordAlertEmit NOT called (so the alert can retry next tick)', async () => {
    sendTelegramMock.mockResolvedValueOnce({ ok: false, error: 'network down' } as any);
    const dispatch = await loadDispatch();
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(1);
    // No history written, so the second call within 24h still fires.
    expect(ALERT_HISTORY.size).toBe(0);
    sendTelegramMock.mockResolvedValueOnce({ ok: true });
    await dispatch(makeDecision(), 0);
    expect(sendTelegramMock).toHaveBeenCalledTimes(2);
    expect(ALERT_HISTORY.size).toBe(1);
  });
});
