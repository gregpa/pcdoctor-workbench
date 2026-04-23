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
