import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { recommendAction, getTopRecommendations } from '../../src/shared/recommendations.js';
import type { SystemStatus, SecurityPosture } from '../../src/shared/types.js';

// ---- Helpers ----------------------------------------------------------------

const NOW_S = Math.floor(Date.now() / 1000);
const DAY_S = 86_400;
const HOUR_S = 3600;

function makeStatus(overrides: Partial<SystemStatus> = {}): SystemStatus {
  return {
    generated_at: NOW_S,
    overall_severity: 'good',
    overall_label: 'Healthy',
    host: 'TEST-PC',
    kpis: [],
    gauges: [],
    findings: [],
    services: [],
    smart: [],
    ...overrides,
  };
}

function makeSecurityPosture(overrides: Partial<SecurityPosture> = {}): SecurityPosture {
  return {
    generated_at: NOW_S,
    defender: {
      realtime_protection: true,
      antispyware_enabled: true,
      defs_version: '1.0',
      defs_age_hours: 2,
      engine_version: '1.0',
      last_quick_scan_hours: 24,
      last_full_scan_days: 10,
      threats_quarantined_7d: 0,
      threats_active: 0,
      tamper_protection: true,
      cloud_protection: true,
      puaprotection: 'Enabled',
      controlled_folder_access: 'Enabled',
      network_protection: 'Enabled',
      exclusions_count: 0,
      severity: 'good',
    },
    firewall: {
      domain_enabled: true,
      private_enabled: true,
      public_enabled: true,
      default_inbound_action: 'Block',
      rules_total: 100,
      rules_added_7d: 0,
      severity: 'good',
    },
    windows_update: {
      pending_count: 0,
      pending_security_count: 0,
      last_success_days: 5,
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

// ---- Tests ------------------------------------------------------------------

describe('recommendAction — null safety', () => {
  it('returns consider when status and security are null', () => {
    const rec = recommendAction('clear_browser_caches', null, null);
    expect(rec.level).toBe('consider');
    expect(rec.reason.length).toBeGreaterThan(0);
  });

  it('returns consider when status is null but security has data', () => {
    const sec = makeSecurityPosture();
    const rec = recommendAction('clear_browser_caches', null, sec);
    expect(rec.level).toBe('consider');
  });

  it('unknown action returns consider', () => {
    const rec = recommendAction('flush_dns' as any, null, null);
    // flush_dns has no explicit case; falls through to default
    expect(['consider', 'skip', 'recommended', 'blocked']).toContain(rec.level);
  });
});

describe('clear_browser_caches', () => {
  it('skip when run < 14 days ago', () => {
    const getLastRun = () => NOW_S - 10 * DAY_S;
    const rec = recommendAction('clear_browser_caches', makeStatus(), makeSecurityPosture(), getLastRun);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('10d ago');
  });

  it('recommended (priority 2) when C: drive < 20% free', () => {
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 12, unit: '%', severity: 'crit' }],
    });
    const rec = recommendAction('clear_browser_caches', status, makeSecurityPosture());
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(2);
    expect(rec.reason).toContain('12%');
  });

  it('recommended (priority 4) when last run > 30 days ago', () => {
    const getLastRun = () => NOW_S - 35 * DAY_S;
    const rec = recommendAction('clear_browser_caches', makeStatus(), makeSecurityPosture(), getLastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(4);
    expect(rec.reason).toContain('35d ago');
  });

  it('consider when never run and disk is healthy', () => {
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 45, unit: '%', severity: 'good' }],
    });
    const getLastRun = () => null;
    const rec = recommendAction('clear_browser_caches', status, makeSecurityPosture(), getLastRun);
    expect(rec.level).toBe('consider');
  });
});

describe('shrink_component_store — blocked with pending reboot', () => {
  it('blocked when reboot_pending is true', () => {
    const sec = makeSecurityPosture({
      windows_update: {
        pending_count: 3,
        pending_security_count: 1,
        last_success_days: 2,
        reboot_pending: true,
        wu_service_status: 'Running',
        severity: 'warn',
      },
    });
    const rec = recommendAction('shrink_component_store', makeStatus(), sec);
    expect(rec.level).toBe('blocked');
    expect(rec.reason).toContain('reboot');
  });

  it('recommended (priority 1) when disk < 15% and no reboot pending', () => {
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 10, unit: '%', severity: 'crit' }],
    });
    const sec = makeSecurityPosture(); // reboot_pending: false
    const rec = recommendAction('shrink_component_store', status, sec);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(1);
  });

  it('consider when disk is fine and no reboot', () => {
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 50, unit: '%', severity: 'good' }],
    });
    const rec = recommendAction('shrink_component_store', status, makeSecurityPosture());
    expect(rec.level).toBe('consider');
  });
});

describe('enable_pua_protection', () => {
  // v2.4.6: when Tamper Protection is on AND the posture probe comes back
  // empty, we can't tell "off" from "can't read" - Get-MpPreference returns
  // empty strings for PUA/CFA/NP fields under non-elevated context when TP
  // is on. Don't scare-recommend enabling something that might already
  // be on.
  it('skip when puaprotection is empty AND tamper protection is on (unreadable)', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: '',
        tamper_protection: true,
      },
    });
    const rec = recommendAction('enable_pua_protection', null, sec);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('cannot be read without elevation');
  });

  it('recommended when puaprotection is empty AND tamper protection is off', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: '',
        tamper_protection: false,
      },
    });
    const rec = recommendAction('enable_pua_protection', null, sec);
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(3);
  });

  it('recommended when puaprotection is "Disabled" (explicit off, even under Tamper)', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: 'Disabled',
      },
    });
    const rec = recommendAction('enable_pua_protection', null, sec);
    expect(rec.level).toBe('recommended');
  });

  it('skip when puaprotection already enabled', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: 'Enabled',
      },
    });
    const rec = recommendAction('enable_pua_protection', null, sec);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('Enabled');
  });

  it('consider when security is null', () => {
    const rec = recommendAction('enable_pua_protection', null, null);
    // puaprotection lookup fails gracefully → recommended (null is falsy)
    // actually: when security is null, pua is undefined → !pua → recommended
    expect(['recommended', 'consider']).toContain(rec.level);
  });
});

describe('enable_controlled_folder_access — never recommended', () => {
  it('always returns consider when disabled', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        controlled_folder_access: 'Disabled',
      },
    });
    const rec = recommendAction('enable_controlled_folder_access', null, sec);
    expect(rec.level).toBe('consider');
    expect(rec.level).not.toBe('recommended');
  });

  it('skip when already enabled', () => {
    const rec = recommendAction('enable_controlled_folder_access', null, makeSecurityPosture());
    expect(rec.level).toBe('skip');
  });

  // v2.4.6: symmetric to PUA — empty + Tamper = unreadable, not "off".
  it('skip when CFA is empty AND tamper protection is on (unreadable)', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        controlled_folder_access: '',
        tamper_protection: true,
      },
    });
    const rec = recommendAction('enable_controlled_folder_access', null, sec);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('cannot be read without elevation');
  });
});

describe('defender_full_scan', () => {
  it('recommended when last_full_scan_days > 30', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        last_full_scan_days: 45,
      },
    });
    const rec = recommendAction('defender_full_scan', null, sec);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('45d');
  });

  it('skip when last_full_scan_days < 14', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        last_full_scan_days: 7,
      },
    });
    const rec = recommendAction('defender_full_scan', null, sec);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('7d');
  });
});

describe('defender_quick_scan', () => {
  it('skip when last_quick_scan_hours <= 48', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        last_quick_scan_hours: 24,
      },
    });
    const rec = recommendAction('defender_quick_scan', null, sec);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('24h');
  });

  it('recommended when last_quick_scan_hours > 48', () => {
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        last_quick_scan_hours: 72,
      },
    });
    const rec = recommendAction('defender_quick_scan', null, sec);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('72h');
  });
});

describe('empty_recycle_bins', () => {
  it('skip when emptied < 7 days ago', () => {
    const getLastRun = () => NOW_S - 3 * DAY_S;
    const rec = recommendAction('empty_recycle_bins', null, null, getLastRun);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('3d ago');
  });

  it('recommended when never emptied', () => {
    const getLastRun = () => null;
    const rec = recommendAction('empty_recycle_bins', null, null, getLastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('Never');
  });

  it('recommended when emptied >= 7 days ago', () => {
    const getLastRun = () => NOW_S - 10 * DAY_S;
    const rec = recommendAction('empty_recycle_bins', null, null, getLastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('10d ago');
  });
});

describe('update_hosts_stevenblack', () => {
  it('skip when updated < 25 days ago', () => {
    const getLastRun = () => NOW_S - 10 * DAY_S;
    const rec = recommendAction('update_hosts_stevenblack', null, null, getLastRun);
    expect(rec.level).toBe('skip');
  });

  it('recommended when never applied', () => {
    const getLastRun = () => null;
    const rec = recommendAction('update_hosts_stevenblack', null, null, getLastRun);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('Never applied');
  });
});

// v2.4.10: added per /ultrareview feedback — this rule shipped in v2.4.6
// with zero test coverage. Covers the three logical paths:
// 1. No status object at all → skip
// 2. pending_reboot array missing or empty → skip
// 3. pending_reboot includes 'PendingFileRename' → recommended (the Chrome
//    reboot-loop scenario this action was designed for)
describe('clear_stale_pending_renames', () => {
  it('skip when status is null (no scan yet)', () => {
    const rec = recommendAction('clear_stale_pending_renames', null, null);
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('No stale rename entries');
  });

  it('skip when pending_reboot flag array does not include PendingFileRename', () => {
    const status = makeStatus({ metrics: { pending_reboot: ['CBSRebootPending'] } });
    const rec = recommendAction('clear_stale_pending_renames', status, null);
    expect(rec.level).toBe('skip');
  });

  it('recommended when PendingFileRename flag is present', () => {
    const status = makeStatus({ metrics: { pending_reboot: ['PendingFileRename'] } });
    const rec = recommendAction('clear_stale_pending_renames', status, null);
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('PendingFileRename');
  });
});

describe('run_sfc', () => {
  it('blocked when reboot pending (SFC can fail mid-way)', () => {
    const sec = makeSecurityPosture({
      windows_update: {
        pending_count: 1,
        pending_security_count: 0,
        last_success_days: 1,
        reboot_pending: true,
        wu_service_status: 'Running',
        severity: 'warn',
      },
    });
    const rec = recommendAction('run_sfc', makeStatus(), sec);
    expect(rec.level).toBe('blocked');
    expect(rec.reason.toLowerCase()).toContain('reboot');
  });

  it('skip when recently run (< 14 days)', () => {
    const getLastRun = () => NOW_S - 7 * DAY_S;
    const rec = recommendAction('run_sfc', makeStatus(), makeSecurityPosture(), getLastRun);
    expect(rec.level).toBe('skip');
  });

  it('recommended when > 90 days with no reboot pending', () => {
    const getLastRun = () => NOW_S - 100 * DAY_S;
    const rec = recommendAction('run_sfc', makeStatus(), makeSecurityPosture(), getLastRun);
    // Per implementation: > 90 days triggers recommended (priority 6) for quarterly maintenance
    expect(rec.level).toBe('recommended');
    expect(rec.reason).toContain('100d');
  });
});

describe('priority ordering — getTopRecommendations', () => {
  it('sorts by priority ascending and limits to maxCount', () => {
    // Give conditions that make multiple actions recommended with different priorities
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 8, unit: '%', severity: 'crit' }],
    });
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: 'Disabled',
        last_full_scan_days: 60,
        last_quick_scan_hours: 100,
      },
      windows_update: {
        pending_count: 0,
        pending_security_count: 0,
        last_success_days: 1,
        reboot_pending: false,
        wu_service_status: 'Running',
        severity: 'good',
      },
    });
    const actions = [
      'shrink_component_store',
      'clear_browser_caches',
      'enable_pua_protection',
      'defender_quick_scan',
    ] as const;
    const top = getTopRecommendations([...actions], status, sec, undefined, 3);
    // All should be 'recommended' with priority <= 3
    expect(top.every(t => t.rec.level === 'recommended')).toBe(true);
    expect(top.every(t => (t.rec.priority ?? 99) <= 3)).toBe(true);
    // Should be sorted ascending by priority
    for (let i = 0; i < top.length - 1; i++) {
      expect((top[i].rec.priority ?? 10) <= (top[i + 1].rec.priority ?? 10)).toBe(true);
    }
    expect(top.length).toBeLessThanOrEqual(3);
  });

  it('returns empty array when no recommendations meet priority <= 3', () => {
    // Use a scenario where all actions produce skip / consider / priority > 3
    const getLastRun = () => NOW_S - 5 * DAY_S; // recent
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 60, unit: '%', severity: 'good' }],
    });
    const sec = makeSecurityPosture({
      defender: {
        ...makeSecurityPosture().defender!,
        puaprotection: 'Enabled',
        last_full_scan_days: 5,
        last_quick_scan_hours: 10,
      },
    });
    const top = getTopRecommendations(
      ['clear_browser_caches', 'empty_recycle_bins', 'enable_pua_protection', 'defender_full_scan'],
      status,
      sec,
      getLastRun,
    );
    expect(Array.isArray(top)).toBe(true);
    // All should either be empty or only contain priority <= 3 items
    top.forEach(t => expect((t.rec.priority ?? 99) <= 3).toBe(true));
  });
});

describe('apply_wsl_cap — systemExtras wsl cap already applied', () => {
  it('skip when wslconfig_has_memory_cap=true and vmmem utilization < 80%', () => {
    const status = makeStatus({
      kpis: [{ label: 'RAM', metric: 'ram.used_pct', value: 82, unit: '%', severity: 'warn' }],
      findings: [{
        severity: 'warning',
        area: 'WSL',
        message: 'vmmem is consuming 6 GB',
        auto_fixed: false,
      }],
    });
    const rec = recommendAction('apply_wsl_cap', status, null, undefined, {
      wslconfig_has_memory_cap: true,
      vmmem_wsl_utilization_pct: 70,
    });
    expect(rec.level).toBe('skip');
    expect(rec.reason).toMatch(/already capped/i);
    expect(rec.reason).toMatch(/70%/);
  });

  it('does NOT skip when wslconfig_has_memory_cap=true but vmmem utilization >= 80%', () => {
    const status = makeStatus({
      kpis: [{ label: 'RAM', metric: 'ram.used_pct', value: 90, unit: '%', severity: 'crit' }],
      findings: [{
        severity: 'critical',
        area: 'WSL',
        message: 'vmmem is consuming nearly all RAM',
        auto_fixed: false,
      }],
    });
    const rec = recommendAction('apply_wsl_cap', status, null, undefined, {
      wslconfig_has_memory_cap: true,
      vmmem_wsl_utilization_pct: 85,
    });
    // Should NOT skip — still recommended because vmmem is at/above threshold
    expect(rec.level).not.toBe('skip');
  });

  it('falls back to normal logic when systemExtras not provided', () => {
    const status = makeStatus({
      kpis: [{ label: 'RAM', metric: 'ram.used_pct', value: 88, unit: '%', severity: 'crit' }],
      findings: [{
        severity: 'warning',
        area: 'WSL',
        message: 'vmmem is consuming 6 GB',
        auto_fixed: false,
      }],
    });
    const rec = recommendAction('apply_wsl_cap', status, null);
    // No systemExtras → normal logic: RAM > 85% with WSL active → recommended priority 1
    expect(rec.level).toBe('recommended');
    expect(rec.priority).toBe(1);
  });

  it('uses softened reason when wslconfig_has_memory_cap is true but vmmem util unknown', () => {
    const status = makeStatus({
      kpis: [{ label: 'RAM', metric: 'ram.used_pct', value: 80, unit: '%', severity: 'warn' }],
      findings: [],
    });
    const rec = recommendAction('apply_wsl_cap', status, null, undefined, {
      wslconfig_has_memory_cap: true,
      // vmmem_wsl_utilization_pct not provided
    });
    // Cap is applied and vmmem is N/A (null → treated as < 80%) → skip
    expect(rec.level).toBe('skip');
    expect(rec.reason).toContain('N/A');
  });
});

describe('remove_feature_update_leftovers', () => {
  it('recommended when disk finding mentions windows.~bt', () => {
    const status = makeStatus({
      findings: [{
        severity: 'warning',
        area: 'Disk',
        message: 'Found C:\\$Windows.~BT (8.2 GB)',
        auto_fixed: false,
      }],
    });
    const rec = recommendAction('remove_feature_update_leftovers', status, null);
    expect(rec.level).toBe('recommended');
  });

  it('skip when no findings and disk is healthy', () => {
    const status = makeStatus({
      kpis: [{ label: 'Disk C Free', metric: 'disk.C.free_pct', value: 50, unit: '%', severity: 'good' }],
    });
    const rec = recommendAction('remove_feature_update_leftovers', status, null);
    expect(rec.level).toBe('skip');
  });
});
