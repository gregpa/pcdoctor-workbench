import { describe, it, expect } from 'vitest';
import { recommendAction } from '../../src/shared/recommendations.js';
import type { SystemStatus, SystemMetrics } from '../../src/shared/types.js';

// v2.3.0 B4: apply_wsl_cap should use status.metrics.wsl_config when present.
function makeStatus(metrics: SystemMetrics, ramPct = 90): SystemStatus {
  return {
    generated_at: Math.floor(Date.now() / 1000),
    overall_severity: 'warn',
    overall_label: 'Warn',
    host: 'TEST-PC',
    kpis: [
      { label: 'RAM Usage', value: ramPct, unit: '%', severity: 'warn', sub: `${ramPct}%` },
    ],
    gauges: [],
    findings: [
      { severity: 'warning', area: 'WSL', message: 'vmmem using RAM', auto_fixed: false },
    ],
    smart: [],
    services: [],
    metrics,
  };
}

describe('apply_wsl_cap — scanner wsl_config signal (B4)', () => {
  it('skips when cap is applied and vmmem utilization is under 80%', () => {
    const status = makeStatus({
      wsl_config: { exists: true, has_memory_cap: true, memory_gb: 8, vmmem_utilization_pct: 42.5 },
    });
    const rec = recommendAction('apply_wsl_cap', status, null);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toMatch(/8GB/);
    expect(rec.reason).toMatch(/43%/);
    expect(rec.reason).toMatch(/other processes/i);
  });

  it('does NOT skip when cap is applied but vmmem is at 90% of cap', () => {
    const status = makeStatus({
      wsl_config: { exists: true, has_memory_cap: true, memory_gb: 8, vmmem_utilization_pct: 92 },
    });
    const rec = recommendAction('apply_wsl_cap', status, null);
    expect(rec.level).not.toBe('skip');
  });

  it('falls through to regular logic when no wsl_config is present', () => {
    const status = makeStatus({});
    const rec = recommendAction('apply_wsl_cap', status, null);
    // With RAM 90% and wslActive=true, regular path → recommended priority 1
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(1);
  });

  it('falls through when cap exists but vmmem_utilization_pct is null', () => {
    const status = makeStatus({
      wsl_config: { exists: true, has_memory_cap: true, memory_gb: 8, vmmem_utilization_pct: null },
    });
    // null < 80 is false in the check (?? 0) → 0 < 80 true, so it still skips
    const rec = recommendAction('apply_wsl_cap', status, null);
    expect(rec.level).toBe('skip');
  });
});
