// Tests for deriveServiceDotColor (v2.5.10) -- single source of truth for
// the service-status dot color used by ServicePill and ServiceDetailModal.
// The function is pure, so no mocking is needed.
import { describe, it, expect } from 'vitest';
import { deriveServiceDotColor } from '../../src/renderer/lib/serviceDotColor.js';
import type { ServiceHealth } from '../../src/shared/types.js';

// Minimal valid ServiceHealth object. Required fields: key, display, status, status_severity.
function svc(overrides: Partial<ServiceHealth> & Pick<ServiceHealth, 'status'>): ServiceHealth {
  return {
    key: 'TestService',
    display: 'Test Service',
    status_severity: 'good',
    ...overrides,
  };
}

describe('deriveServiceDotColor -- running states return bg-status-good', () => {
  it('status Running, start Automatic returns bg-status-good', () => {
    expect(deriveServiceDotColor(svc({ status: 'Running', start: 'Automatic' }))).toBe('bg-status-good');
  });

  it('status "running (3 procs)" (Docker pseudo-service, no start) returns bg-status-good', () => {
    expect(deriveServiceDotColor(svc({ status: 'running (3 procs)' }))).toBe('bg-status-good');
  });

  it('status "service-running" (Cloudflared up), start Automatic returns bg-status-good', () => {
    expect(deriveServiceDotColor(svc({ status: 'service-running', start: 'Automatic' }))).toBe('bg-status-good');
  });

  it('status "process-running" (Cloudflared process path, no start) returns bg-status-good', () => {
    expect(deriveServiceDotColor(svc({ status: 'process-running' }))).toBe('bg-status-good');
  });

  it('status RUNNING (uppercase), start Automatic returns bg-status-good (case-insensitive)', () => {
    expect(deriveServiceDotColor(svc({ status: 'RUNNING', start: 'Automatic' }))).toBe('bg-status-good');
  });
});

describe('deriveServiceDotColor -- critical stopped states return bg-status-crit', () => {
  it('status Stopped, start Automatic returns bg-status-crit (auto service unexpectedly down)', () => {
    expect(deriveServiceDotColor(svc({ status: 'Stopped', start: 'Automatic', status_severity: 'crit' }))).toBe('bg-status-crit');
  });

  it('status "NOT RUNNING", start Automatic returns bg-status-crit', () => {
    expect(deriveServiceDotColor(svc({ status: 'NOT RUNNING', start: 'Automatic' }))).toBe('bg-status-crit');
  });

  it('status "service-stopped", start Automatic (Cloudflared down) returns bg-status-crit', () => {
    expect(deriveServiceDotColor(svc({ status: 'service-stopped', start: 'Automatic' }))).toBe('bg-status-crit');
  });

  it('status OFFLINE, start Automatic (Cloudflared fully down) returns bg-status-crit', () => {
    expect(deriveServiceDotColor(svc({ status: 'OFFLINE', start: 'Automatic' }))).toBe('bg-status-crit');
  });
});

describe('deriveServiceDotColor -- warn stopped states return bg-status-warn', () => {
  it('status Stopped, start Manual (BITS case -- manually stopped is normal) returns bg-status-warn', () => {
    expect(deriveServiceDotColor(svc({ status: 'Stopped', start: 'Manual' }))).toBe('bg-status-warn');
  });

  it('status Stopped, start Disabled returns bg-status-warn', () => {
    expect(deriveServiceDotColor(svc({ status: 'Stopped', start: 'Disabled' }))).toBe('bg-status-warn');
  });

  it('status Stopped, start undefined (pseudo-service path) returns bg-status-warn', () => {
    expect(deriveServiceDotColor(svc({ status: 'Stopped' }))).toBe('bg-status-warn');
  });

  it('status "NOT RUNNING", no start (Docker GUI dead) returns bg-status-warn (stoppedManual via no start)', () => {
    expect(deriveServiceDotColor(svc({ status: 'NOT RUNNING' }))).toBe('bg-status-warn');
  });

  it('status "not_installed", no start returns bg-status-warn', () => {
    expect(deriveServiceDotColor(svc({ status: 'not_installed' }))).toBe('bg-status-warn');
  });

  it('status STOPPED uppercase, start Manual returns bg-status-warn (case-insensitive)', () => {
    expect(deriveServiceDotColor(svc({ status: 'STOPPED', start: 'Manual' }))).toBe('bg-status-warn');
  });
});

describe('deriveServiceDotColor -- severity fallback for unrecognized transitional states', () => {
  it('status StartPending, start Automatic, status_severity warn returns bg-status-warn via fallback', () => {
    expect(deriveServiceDotColor(svc({ status: 'StartPending', start: 'Automatic', status_severity: 'warn' }))).toBe('bg-status-warn');
  });

  it('status Paused, start Manual, status_severity crit returns bg-status-crit via fallback', () => {
    expect(deriveServiceDotColor(svc({ status: 'Paused', start: 'Manual', status_severity: 'crit' }))).toBe('bg-status-crit');
  });
});

describe('deriveServiceDotColor -- unknown fallback returns bg-surface-600', () => {
  it('status "weird unknown", no start, status_severity good returns bg-surface-600 (not running, not stopped, severity=good falls through)', () => {
    expect(deriveServiceDotColor(svc({ status: 'weird unknown', status_severity: 'good' }))).toBe('bg-surface-600');
  });

  it('status empty string, no start returns bg-surface-600', () => {
    expect(deriveServiceDotColor(svc({ status: '' }))).toBe('bg-surface-600');
  });
});

describe('deriveServiceDotColor -- substring guard: running substring must not misclassify non-running status', () => {
  it('status "not running today" (contains "running" but is a not-running variant) with no start returns bg-status-warn, not bg-status-good', () => {
    // Guard: the function must reject "not running" prefix before matching "running" substring.
    expect(deriveServiceDotColor(svc({ status: 'not running today' }))).toBe('bg-status-warn');
  });
});
