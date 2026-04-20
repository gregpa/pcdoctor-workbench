/**
 * tests/shared/recommendations-quick-actions.test.ts
 *
 * Covers the QUICK_ACTIONS panel cases added in v2.2.0:
 *   clear_temp_files, flush_dns, flush_arp_cache, compact_docker,
 *   trim_ssd, restart_explorer, run_sfc, run_dism, kill_process,
 *   remap_nas, apply_wsl_cap, rebuild_search_index
 *
 * Also validates improvements to existing partially-covered cases.
 */

import { describe, it, expect } from 'vitest';
import { recommendAction } from '../../src/shared/recommendations.js';
import type { SystemStatus, SecurityPosture, Finding, ServiceHealth } from '../../src/shared/types.js';

// ── Fixture helpers ─────────────────────────────────────────────────────────

const NOW_S = Math.floor(Date.now() / 1000);
const DAY_S = 86_400;

function daysAgo(d: number): number {
  return NOW_S - d * DAY_S;
}

function baseStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    generated_at: NOW_S,
    overall_severity: 'good',
    overall_label: 'Healthy',
    host: 'TEST-PC',
    kpis: [
      { label: 'NAS', value: 2, severity: 'good', sub: '2 mappings' },
    ],
    gauges: [],
    findings: [],
    services: [],
    smart: [],
    ...overrides,
  };
}

function baseSecurity(overrides: Partial<SecurityPosture> = {}): SecurityPosture {
  return {
    generated_at: NOW_S,
    defender: null,
    firewall: null,
    windows_update: {
      pending_count: 0,
      pending_security_count: 0,
      last_success_days: 1,
      reboot_pending: false,
      wu_service_status: 'Running',
      severity: 'good',
    },
    failed_logins: null,
    bitlocker: [],
    uac: null,
    gpu_driver: null,
    persistence_new_count: 0,
    persistence_items: [],
    threat_indicators: [],
    smart: [],
    overall_severity: 'good',
    ...overrides,
  };
}

function finding(area: string, message: string, detail?: unknown): Finding {
  return { severity: 'warning', area, message, detail, auto_fixed: false };
}

function dockerService(running: boolean): ServiceHealth {
  return {
    key: 'com.docker.service',
    display: 'Docker Desktop',
    status: running ? 'Running' : 'Stopped',
    status_severity: running ? 'good' : 'warn',
    start: running ? 'Automatic' : 'Manual',
  };
}

// ── apply_wsl_cap ────────────────────────────────────────────────────────────

describe('apply_wsl_cap', () => {
  it('priority 1 — RAM 95% + WSL vmmem finding', () => {
    const status = baseStatus({
      kpis: [{ label: 'RAM Usage', value: 95, unit: '%', severity: 'crit', sub: '' }],
      findings: [finding('Memory', 'vmmemWSL is using 14 GB of RAM')],
    });
    const rec = recommendAction('apply_wsl_cap', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(1);
  });

  it('priority 4 — RAM 80% with WSL active', () => {
    const status = baseStatus({
      kpis: [{ label: 'RAM Usage', value: 80, unit: '%', severity: 'warn', sub: '' }],
      findings: [finding('WSL', 'WSL2 memory usage elevated')],
    });
    const rec = recommendAction('apply_wsl_cap', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(4);
  });

  it('skip — no WSL signal and RAM <= 75%', () => {
    const status = baseStatus({
      kpis: [{ label: 'RAM Usage', value: 60, unit: '%', severity: 'good', sub: '' }],
    });
    const rec = recommendAction('apply_wsl_cap', status, baseSecurity());
    expect(rec.level).toBe('skip');
  });
});

// ── run_sfc ──────────────────────────────────────────────────────────────────

describe('run_sfc', () => {
  it('blocked — pending reboot', () => {
    const sec = baseSecurity({
      windows_update: { pending_count: 2, pending_security_count: 0, last_success_days: 1, reboot_pending: true, wu_service_status: 'Running', severity: 'warn' },
    });
    const rec = recommendAction('run_sfc', baseStatus(), sec);
    expect(rec.level).toBe('blocked');
    expect(rec.reason).toMatch(/reboot/i);
  });

  it('recommended priority 2 — Stability finding present', () => {
    const status = baseStatus({
      findings: [finding('Stability', 'BSOD recorded in last 7 days')],
    });
    const rec = recommendAction('run_sfc', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(2);
  });

  it('recommended priority 6 — last run > 90 days', () => {
    const lastRun = () => daysAgo(100);
    const rec = recommendAction('run_sfc', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(6);
  });

  it('skip — ran recently (< 14 days)', () => {
    const lastRun = () => daysAgo(7);
    const rec = recommendAction('run_sfc', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('skip');
  });
});

// ── run_dism ─────────────────────────────────────────────────────────────────

describe('run_dism', () => {
  it('blocked — pending reboot', () => {
    const sec = baseSecurity({
      windows_update: { pending_count: 1, pending_security_count: 0, last_success_days: 1, reboot_pending: true, wu_service_status: 'Running', severity: 'warn' },
    });
    const rec = recommendAction('run_dism', baseStatus(), sec);
    expect(rec.level).toBe('blocked');
    expect(rec.reason).toMatch(/reboot/i);
  });

  it('consider — no special signals', () => {
    const rec = recommendAction('run_dism', baseStatus(), baseSecurity());
    expect(rec.level).toBe('consider');
  });
});

// ── rebuild_search_index ─────────────────────────────────────────────────────

describe('rebuild_search_index', () => {
  it('recommended priority 2 — Search finding present', () => {
    const status = baseStatus({
      findings: [finding('Search', 'Windows Search returning stale results')],
    });
    const rec = recommendAction('rebuild_search_index', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(2);
    expect(rec.reason).toMatch(/admin/i);
  });

  it('skip — last run < 30 days', () => {
    const lastRun = () => daysAgo(15);
    const rec = recommendAction('rebuild_search_index', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('skip');
  });

  it('consider (admin note) — no finding, no recent run', () => {
    const rec = recommendAction('rebuild_search_index', baseStatus(), baseSecurity());
    expect(['consider', 'recommended']).toContain(rec.level);
    expect(rec.reason).toMatch(/admin/i);
  });
});

// ── remap_nas ────────────────────────────────────────────────────────────────

describe('remap_nas', () => {
  it('skip — all NAS mappings Persistent (KPI severity good, value > 0)', () => {
    const status = baseStatus({
      kpis: [{ label: 'NAS', value: 2, severity: 'good', sub: '2 mappings' }],
    });
    const rec = recommendAction('remap_nas', status, baseSecurity());
    expect(rec.level).toBe('skip');
  });

  it('recommended priority 2 — any NAS mapping not Persistent (KPI severity warn)', () => {
    const status = baseStatus({
      kpis: [{ label: 'NAS', value: 0, severity: 'warn', sub: 'No persistent mappings' }],
    });
    const rec = recommendAction('remap_nas', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(2);
  });

  it('recommended priority 2 — NAS unreachable (KPI severity crit)', () => {
    const status = baseStatus({
      kpis: [{ label: 'NAS', value: 0, severity: 'crit', sub: 'Unreachable' }],
    });
    const rec = recommendAction('remap_nas', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(2);
  });
});

// ── compact_docker ───────────────────────────────────────────────────────────

describe('compact_docker', () => {
  it('skip — Docker service not running', () => {
    const status = baseStatus({ services: [dockerService(false)] });
    const rec = recommendAction('compact_docker', status, baseSecurity());
    expect(rec.level).toBe('skip');
    expect(rec.reason).toMatch(/not running/i);
  });

  it('skip — Docker running but compacted within 30 days', () => {
    const lastRun = () => daysAgo(15);
    const status = baseStatus({ services: [dockerService(true)] });
    const rec = recommendAction('compact_docker', status, baseSecurity(), lastRun);
    expect(rec.level).toBe('skip');
  });

  it('recommended priority 6 — Docker running and last compact > 30 days', () => {
    const lastRun = () => daysAgo(40);
    const status = baseStatus({ services: [dockerService(true)] });
    const rec = recommendAction('compact_docker', status, baseSecurity(), lastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(6);
  });

  it('recommended — Docker running, never compacted', () => {
    const status = baseStatus({ services: [dockerService(true)] });
    const rec = recommendAction('compact_docker', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(6);
  });
});

// ── restart_explorer ─────────────────────────────────────────────────────────

describe('restart_explorer', () => {
  it('recommended priority 3 — shell_overlay_count > 20 in finding detail', () => {
    const status = baseStatus({
      findings: [finding('Overlays', 'Too many shell overlay handlers', { count: 24 })],
    });
    const rec = recommendAction('restart_explorer', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(3);
  });

  it('consider — no findings', () => {
    const rec = recommendAction('restart_explorer', baseStatus(), baseSecurity());
    expect(rec.level).toBe('consider');
  });
});

// ── clear_temp_files ─────────────────────────────────────────────────────────

describe('clear_temp_files', () => {
  it('recommended priority 4 — C: drive < 20% free', () => {
    // cFree helper reads from gauges with label containing 'c: free'
    const status = baseStatus({
      kpis: [
        { label: 'NAS', value: 2, severity: 'good', sub: '' },
      ],
      gauges: [{ label: 'C: Free', value: 12, display: '12%', subtext: '60/500 GB', severity: 'crit' }],
    });
    const rec = recommendAction('clear_temp_files', status, baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(4);
    expect(rec.reason).toMatch(/300-700 MB/);
  });

  it('recommended priority 7 — last run > 30 days', () => {
    const lastRun = () => daysAgo(35);
    const rec = recommendAction('clear_temp_files', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(7);
  });

  it('skip — ran recently and disk healthy', () => {
    const lastRun = () => daysAgo(10);
    const rec = recommendAction('clear_temp_files', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('skip');
  });
});

// ── flush_dns ────────────────────────────────────────────────────────────────

describe('flush_dns', () => {
  it('recommended — DNS finding present', () => {
    const status = baseStatus({
      findings: [finding('DNS', 'DNS resolution failures detected')],
    });
    const rec = recommendAction('flush_dns', status, baseSecurity());
    expect(rec.level).toBe('recommended');
  });

  it('consider — no signals', () => {
    const rec = recommendAction('flush_dns', baseStatus(), baseSecurity());
    expect(rec.level).toBe('consider');
    expect(rec.reason).toMatch(/dns changes|vpn/i);
  });
});

// ── flush_arp_cache ──────────────────────────────────────────────────────────

describe('flush_arp_cache', () => {
  it('recommended — Network finding present', () => {
    const status = baseStatus({
      findings: [finding('Network', 'ARP table stale entries detected')],
    });
    const rec = recommendAction('flush_arp_cache', status, baseSecurity());
    expect(rec.level).toBe('recommended');
  });

  it('consider — no network findings', () => {
    const rec = recommendAction('flush_arp_cache', baseStatus(), baseSecurity());
    expect(rec.level).toBe('consider');
  });
});

// ── trim_ssd ─────────────────────────────────────────────────────────────────

describe('trim_ssd', () => {
  it('recommended priority 5 — last run > 25 days', () => {
    const lastRun = () => daysAgo(30);
    const rec = recommendAction('trim_ssd', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(5);
  });

  it('skip — last run < 25 days', () => {
    const lastRun = () => daysAgo(10);
    const rec = recommendAction('trim_ssd', baseStatus(), baseSecurity(), lastRun);
    expect(rec.level).toBe('skip');
  });

  it('recommended — never run', () => {
    const rec = recommendAction('trim_ssd', baseStatus(), baseSecurity());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(5);
  });
});

// ── kill_process ─────────────────────────────────────────────────────────────

describe('kill_process', () => {
  it('always consider — on-demand tool', () => {
    const rec = recommendAction('kill_process', baseStatus(), baseSecurity());
    expect(rec.level).toBe('consider');
    expect(rec.reason).toMatch(/on-demand/i);
  });
});

// ── priority semantics smoke test ────────────────────────────────────────────

describe('priority field semantics', () => {
  it('all recommended verdicts with a priority have it in 1..10', () => {
    const cases = [
      recommendAction('apply_wsl_cap', baseStatus({
        kpis: [{ label: 'RAM Usage', value: 95, unit: '%', severity: 'crit', sub: '' }],
        findings: [finding('WSL', 'vmmem is huge')],
      }), baseSecurity()),
      recommendAction('run_sfc', baseStatus({ findings: [finding('Stability', 'BSOD')] }), baseSecurity()),
      recommendAction('remap_nas', baseStatus({ kpis: [{ label: 'NAS', value: 0, severity: 'crit', sub: '' }] }), baseSecurity()),
      recommendAction('trim_ssd', baseStatus(), baseSecurity()),
      recommendAction('compact_docker', baseStatus({ services: [dockerService(true)] }), baseSecurity()),
    ];
    for (const rec of cases) {
      if (rec.level === 'recommended' && rec.priority !== undefined) {
        expect(rec.priority).toBeGreaterThanOrEqual(1);
        expect(rec.priority).toBeLessThanOrEqual(10);
      }
    }
  });
});
