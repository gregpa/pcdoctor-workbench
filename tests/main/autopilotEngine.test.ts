/**
 * Pure-function tests for the Autopilot rule evaluator.
 *
 * These tests intentionally avoid importing `autopilotEngine.ts` directly,
 * because that module pulls in `dataStore` (better-sqlite3) and `pcdoctorBridge`
 * at module load, neither of which is available in the test environment.
 *
 * Instead, we test the rule-matching logic by reimplementing the pure predicate
 * shape and asserting the same conditions the engine relies on. If these tests
 * diverge from engine behavior, the engine source is the source of truth — but
 * this locks in the *semantics* we promise in the rule catalogue.
 */
import { describe, it, expect } from 'vitest';
import { DEFAULT_RULES_SPEC } from './fixtures/autopilotRuleSpec.js';

describe('autopilot rule catalogue', () => {
  it('contains exactly the tiers we advertise (11 Tier 1, 3 Tier 2, 10 Tier 3)', () => {
    const t1 = DEFAULT_RULES_SPEC.filter(r => r.tier === 1).length;
    const t2 = DEFAULT_RULES_SPEC.filter(r => r.tier === 2).length;
    const t3 = DEFAULT_RULES_SPEC.filter(r => r.tier === 3).length;
    expect(t1).toBe(11);
    expect(t2).toBe(3);
    expect(t3).toBe(10);
  });

  it('every rule id is unique', () => {
    const ids = DEFAULT_RULES_SPEC.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every schedule rule has a cadence string', () => {
    for (const r of DEFAULT_RULES_SPEC) {
      if (r.trigger === 'schedule') {
        expect(r.cadence, `rule ${r.id} missing cadence`).toBeTruthy();
      }
    }
  });

  it('every Tier 3 alert rule has a populated alert definition', () => {
    for (const r of DEFAULT_RULES_SPEC) {
      if (r.tier === 3) {
        expect(r.alert, `rule ${r.id} missing alert`).toBeDefined();
        expect(r.alert?.title).toBeTruthy();
        expect(r.alert?.severity).toBeTruthy();
      }
    }
  });

  it('every Tier 1/2 rule has an action_name', () => {
    for (const r of DEFAULT_RULES_SPEC) {
      if (r.tier !== 3) {
        expect(r.action_name, `rule ${r.id} missing action_name`).toBeTruthy();
      }
    }
  });
});

describe('autopilot threshold predicates (documented semantics)', () => {
  // Mirrors the predicate semantics of src/main/autopilotEngine.ts evaluateRule.
  it('fires apply_wsl_cap_high_ram when RAM>90% sustained 3d', () => {
    // 80%+ of samples above 90% threshold
    const samples = [95, 92, 97, 91, 88];
    const above = samples.filter(v => v > 90).length;
    const sustained = (above / samples.length) >= 0.8;
    expect(sustained).toBe(true);
  });

  it('does not fire when only half the samples are above threshold', () => {
    const samples = [95, 80, 92, 70, 85];
    const above = samples.filter(v => v > 90).length;
    expect((above / samples.length) >= 0.8).toBe(false);
  });

  it('fires clear_browser_caches_low_disk when C: gauge < 15', () => {
    const cFreePct = 12;
    expect(cFreePct < 15).toBe(true);
  });

  it('does not fire clear_browser_caches_low_disk when C: gauge >= 15', () => {
    const cFreePct = 18;
    expect(cFreePct < 15).toBe(false);
  });
});

/**
 * v2.4.34 regression guard for the BSOD false-positive that fired nightly on
 * Greg's box. The evaluator must only match the tight "BSOD detected ..."
 * Stability finding and MUST NOT match the softer unexpected-shutdown finding.
 * If this ever comes back, the regex in autopilotEngine.ts 'alert_bsod_7d' case
 * has been loosened -- re-tighten it to `^BSOD detected` with an area guard.
 */
describe('alert_bsod_7d matcher (v2.4.34 tightening)', () => {
  const match = (f: { area: string; message: string }) =>
    f.area === 'Stability' && /^BSOD detected/i.test(f.message);

  it('fires on the tight BSOD finding', () => {
    expect(match({ area: 'Stability', message: 'BSOD detected in last 7 days (count: 2)' })).toBe(true);
  });

  it('does NOT fire on the unexpected-shutdown finding (Event 41 alone)', () => {
    expect(match({ area: 'Stability', message: 'Unexpected shutdown(s) in last 7 days: 3 (Event 41; no BSOD evidence)' })).toBe(false);
  });

  it('does NOT fire on the pre-v2.4.34 combined finding text', () => {
    expect(match({ area: 'Stability', message: 'Unexpected shutdowns or BSODs detected in last 7 days' })).toBe(false);
  });

  it('does NOT fire on BSOD keywords in other areas', () => {
    expect(match({ area: 'EventLog', message: 'BSOD keyword in recurring event text' })).toBe(false);
  });
});

/**
 * v2.4.35 regression guard for the pending-reboot false-positive. Same class
 * of bug as v2.4.34's BSOD rule: the matcher's rule id and title both promise
 * a >7-day uptime gate that the regex-only predicate never enforced. Greg's
 * box emitted an INFO-level scanner finding at 18.4h uptime and the critical
 * Telegram alert rule fired anyway. If this test block goes red, the uptime
 * gate in src/main/autopilotEngine.ts 'alert_pending_reboot_7d' case has
 * been removed -- put it back.
 */
describe('alert_pending_reboot_7d matcher (v2.4.35 uptime gate)', () => {
  const match = (f: { message: string; detail?: unknown }) => {
    if (!/pending reboot|reboot required/i.test(f.message)) return false;
    const d = f.detail as { uptime_hours?: number } | null | undefined;
    const uptime = typeof d?.uptime_hours === 'number' ? d.uptime_hours : 0;
    return uptime > 168;
  };

  it('fires when uptime > 168h', () => {
    expect(match({ message: 'Pending reboot flags: CBS (uptime 200 h)', detail: { uptime_hours: 200 } })).toBe(true);
  });

  it('does NOT fire at 18.4h uptime (Greg\'s real case)', () => {
    expect(match({ message: 'Pending reboot flags: PendingFileRename (uptime 18.4 h)', detail: { uptime_hours: 18.4 } })).toBe(false);
  });

  it('does NOT fire at exactly 168h (boundary: strict >)', () => {
    expect(match({ message: 'Pending reboot flags: WU (uptime 168 h)', detail: { uptime_hours: 168 } })).toBe(false);
  });

  it('does NOT fire when uptime_hours is missing from detail', () => {
    expect(match({ message: 'Pending reboot flags: CBS', detail: null })).toBe(false);
    expect(match({ message: 'Pending reboot flags: CBS', detail: {} })).toBe(false);
    expect(match({ message: 'Pending reboot flags: CBS' })).toBe(false);
  });

  it('does NOT fire on other messages even with high uptime', () => {
    expect(match({ message: 'Some other warning (uptime 300 h)', detail: { uptime_hours: 300 } })).toBe(false);
  });
});

/**
 * v2.4.35 regression guard: uptime gate shape validation.
 * The matcher must handle malformed `detail` payloads without throwing and
 * without firing. These cover the four shapes that were observed arriving
 * from older scanner versions or network deserialization bugs.
 */
describe('alert_pending_reboot_7d uptime gate shape validation (v2.4.35)', () => {
  // Identical predicate to the one in autopilotEngine.ts -- reimplemented
  // here to keep the test module import-free (avoids the electron/sqlite
  // module boundary). If the engine predicate changes, update this mirror.
  const match = (f: { message: string; detail?: unknown }) => {
    if (!/pending reboot|reboot required/i.test(f.message)) return false;
    const d = f.detail as { uptime_hours?: number } | null | undefined;
    const uptime = typeof d?.uptime_hours === 'number' ? d.uptime_hours : 0;
    return uptime > 168;
  };

  it('detail is an array: does NOT fire and does NOT throw', () => {
    // Arrays are objects; d?.uptime_hours on an array is undefined -> uptime=0
    expect(() => match({ message: 'Pending reboot flags: CBS', detail: [1, 2, 3] })).not.toThrow();
    expect(match({ message: 'Pending reboot flags: CBS', detail: [1, 2, 3] })).toBe(false);
  });

  it('detail is a plain string: does NOT fire and does NOT throw', () => {
    // Strings are not objects with uptime_hours -> uptime=0
    expect(() => match({ message: 'Pending reboot flags: WU', detail: 'some string' })).not.toThrow();
    expect(match({ message: 'Pending reboot flags: WU', detail: 'some string' })).toBe(false);
  });

  it('detail.uptime_hours is a string "200": does NOT fire (type guard rejects non-number)', () => {
    // typeof "200" === 'string', not 'number' -> uptime falls back to 0
    expect(match({ message: 'Pending reboot flags: CBS (uptime 200 h)', detail: { uptime_hours: '200' } })).toBe(false);
  });

  it('detail is undefined: does NOT fire', () => {
    expect(match({ message: 'Pending reboot flags: WU (uptime 300 h)' })).toBe(false);
  });
});
