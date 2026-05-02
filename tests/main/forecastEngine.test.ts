// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-metric stub for queryMetricTrend. Tests mutate this map to drive
// different configured metrics with different synthetic trend data.
const TREND: Record<string, Array<{ ts: number; value: number }>> = {};

vi.mock('../../src/main/dataStore.js', () => ({
  queryMetricTrend: (category: string, metric: string, _days: number) =>
    TREND[`${category}.${metric}`] ?? [],
  saveForecasts: vi.fn(),
  getSetting: vi.fn(() => null),
}));
vi.mock('../../src/main/notifier.js', () => ({
  notify: vi.fn(async () => {}),
}));

import { generateForecasts } from '../../src/main/forecastEngine.js';

const DAY = 24 * 60 * 60 * 1000;

function linearSeries(start: number, end: number, days: number, endTs = Date.now()): Array<{ ts: number; value: number }> {
  const pts: Array<{ ts: number; value: number }> = [];
  // One point per day, oldest first, ending at endTs.
  for (let i = 0; i < days; i++) {
    const ts = endTs - (days - 1 - i) * DAY;
    const value = start + (end - start) * (i / (days - 1));
    pts.push({ ts, value });
  }
  return pts;
}

describe('generateForecasts', () => {
  beforeEach(() => {
    for (const k of Object.keys(TREND)) delete TREND[k];
  });

  it('returns a ForecastData shape with generated_at in unix seconds', () => {
    const data = generateForecasts();
    expect(data).toBeDefined();
    expect(typeof data.generated_at).toBe('number');
    // generated_at must be in seconds (not ms) — so < year 2100 when read as seconds.
    expect(data.generated_at).toBeLessThan(4000000000);
    expect(Array.isArray(data.projections)).toBe(true);
    expect(Array.isArray(data.insufficient_data)).toBe(true);
  });

  it('metric with <14 points goes to insufficient_data, not projections', () => {
    // RAM: only 10 points
    TREND['ram.used_pct'] = linearSeries(50, 60, 10);
    const data = generateForecasts();
    const insuf = data.insufficient_data.find(i => i.metric === 'ram.used_pct');
    expect(insuf).toBeDefined();
    expect(insuf!.points).toBe(10);
    expect(insuf!.required).toBe(14);
    expect(data.projections.find(p => p.metric === 'ram.used_pct')).toBeUndefined();
  });

  it('metric with <7 day window is insufficient even with 14+ points', () => {
    // 14 points but all within 3 days total
    const endTs = Date.now();
    const pts: Array<{ ts: number; value: number }> = [];
    for (let i = 0; i < 14; i++) {
      pts.push({ ts: endTs - (3 * DAY) + i * (3 * DAY / 13), value: 50 + i });
    }
    TREND['ram.used_pct'] = pts;
    const data = generateForecasts();
    expect(data.insufficient_data.find(i => i.metric === 'ram.used_pct')).toBeDefined();
    expect(data.projections.find(p => p.metric === 'ram.used_pct')).toBeUndefined();
  });

  it('RAM trending up towards 95 critical: projection has projected_critical_date + preventive_action', () => {
    // 30 days of linear climb from 80 → 93. Slope ~ 0.43/day; should hit 95 in ~4-5 days.
    TREND['ram.used_pct'] = linearSeries(80, 93, 30);
    const data = generateForecasts();
    const ram = data.projections.find(p => p.metric === 'ram.used_pct');
    expect(ram).toBeDefined();
    expect(ram!.algorithm).toBe('linear_regression');
    expect(ram!.slope_per_day).not.toBeNull();
    expect(ram!.slope_per_day!).toBeGreaterThan(0);
    expect(ram!.projected_critical_date).not.toBeNull();
    expect(ram!.days_until_critical).not.toBeNull();
    expect(ram!.days_until_critical!).toBeGreaterThan(0);
    expect(ram!.days_until_critical!).toBeLessThan(20);
    expect(ram!.preventive_action?.action_name).toBe('apply_wsl_cap');
    expect(['critical', 'important', 'low']).toContain(ram!.severity);
  });

  it('RAM trending down (getting better) with bad_direction=up: no projected critical date', () => {
    // Falling from 90 → 60 over 30 days. slope < 0, bad_direction='up' → no crossing.
    TREND['ram.used_pct'] = linearSeries(90, 60, 30);
    const data = generateForecasts();
    const ram = data.projections.find(p => p.metric === 'ram.used_pct');
    expect(ram).toBeDefined();
    expect(ram!.slope_per_day!).toBeLessThan(0);
    expect(ram!.projected_critical_date).toBeNull();
    expect(ram!.days_until_critical).toBeNull();
    expect(ram!.severity).toBe('indicator');
  });

  it('Disk free% falling fast (bad_direction=down) projects a critical date', () => {
    // disk.free_pct: critical=10, warn=20. Fall 40 → 12 over 30 days. Should hit 10 soon.
    TREND['disk.free_pct'] = linearSeries(40, 12, 30);
    const data = generateForecasts();
    const disk = data.projections.find(p => p.metric === 'disk.free_pct');
    expect(disk).toBeDefined();
    expect(disk!.slope_per_day!).toBeLessThan(0);
    expect(disk!.projected_critical_date).not.toBeNull();
    expect(disk!.preventive_action?.action_name).toBe('clear_temp_files');
  });

  it('Disk free% rising (bad_direction=down with slope>=0) → no projection', () => {
    TREND['disk.free_pct'] = linearSeries(15, 40, 30);
    const data = generateForecasts();
    const disk = data.projections.find(p => p.metric === 'disk.free_pct');
    expect(disk).toBeDefined();
    expect(disk!.projected_critical_date).toBeNull();
    expect(disk!.severity).toBe('indicator');
  });

  it('EWMA algorithm: events.system_count with recent > critical threshold flags important', () => {
    // 30 points: baseline half averages ~100, recent 7 average ~600, critical=500
    const endTs = Date.now();
    const pts: Array<{ ts: number; value: number }> = [];
    for (let i = 0; i < 30; i++) {
      const ts = endTs - (29 - i) * DAY;
      const value = i < 15 ? 100 : (i < 23 ? 300 : 600);
      pts.push({ ts, value });
    }
    TREND['events.system_count'] = pts;
    const data = generateForecasts();
    const ev = data.projections.find(p => p.metric === 'events.system_count');
    expect(ev).toBeDefined();
    expect(ev!.algorithm).toBe('ewma');
    // slope_per_day is derived from (recent - baseline) / days
    expect(ev!.slope_per_day).not.toBeNull();
    expect(ev!.slope_per_day!).toBeGreaterThan(0);
    // EWMA never sets projected_critical_date
    expect(ev!.projected_critical_date).toBeNull();
    // current value is 600 > 500 critical → severity important
    expect(ev!.severity).toBe('important');
  });

  it('confidence score is in [0,1] and confidence bucket follows thresholds', () => {
    TREND['ram.used_pct'] = linearSeries(50, 70, 30);
    const data = generateForecasts();
    const ram = data.projections.find(p => p.metric === 'ram.used_pct')!;
    expect(ram.confidence_score).toBeGreaterThanOrEqual(0);
    expect(ram.confidence_score).toBeLessThanOrEqual(1);
    const s = ram.confidence_score;
    const expected =
      s >= 0.8 ? 'HIGH' :
      s >= 0.5 ? 'MEDIUM' :
      s >= 0.3 ? 'LOW' : 'INSUFFICIENT';
    expect(ram.confidence).toBe(expected);
  });

  it('r_squared is 1.0 for a perfectly linear trend (within float tolerance)', () => {
    TREND['ram.used_pct'] = linearSeries(50, 80, 30);
    const data = generateForecasts();
    const ram = data.projections.find(p => p.metric === 'ram.used_pct')!;
    expect(ram.r_squared).not.toBeNull();
    expect(ram.r_squared!).toBeCloseTo(1.0, 3);
  });

  it('projections are sorted by severity (critical < important < low < indicator)', () => {
    // Set up 3 metrics with different severities.
    // ram: steep climb → critical (< 7 days to 95)
    TREND['ram.used_pct'] = linearSeries(85, 94, 30);
    // disk: slow fall → important-ish (but we don't need to assert which bucket)
    TREND['disk.free_pct'] = linearSeries(50, 45, 30);
    // cpu: stable → indicator
    TREND['cpu.load_pct'] = linearSeries(30, 31, 30);

    const data = generateForecasts();
    const order = { critical: 0, important: 1, low: 2, indicator: 3 } as const;
    for (let i = 1; i < data.projections.length; i++) {
      const prev = order[data.projections[i - 1].severity];
      const cur = order[data.projections[i].severity];
      expect(prev).toBeLessThanOrEqual(cur);
    }
  });
});
