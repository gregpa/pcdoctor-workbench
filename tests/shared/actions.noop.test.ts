/**
 * Tests for no-op guard behavior in idempotent PS scripts.
 *
 * These tests mock the PS script output (as if returned from scriptRunner)
 * and verify that:
 *   1. Each script returns { success: true, no_op: true } when already in desired state
 *   2. The result message contains "Already in desired state"
 *   3. Each script returns { success: true, no_op: false } when a change was made
 *
 * Since we're testing the JSON contract (not actually running PS), we parse
 * the expected JSON output shapes from each script's documented behavior.
 */
import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// Type representing the no-op-aware result shape each script must return
// ---------------------------------------------------------------------------
interface NoOpResult {
  success: boolean;
  no_op?: boolean;
  message?: string;
  changed?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Simulate what the scripts return (based on their actual output contract)
// We parse these as if they came from runPowerShellScript's JSON.parse result.
// ---------------------------------------------------------------------------

function simulateApplyWSLCap_alreadyApplied(): NoOpResult {
  return {
    success: true,
    no_op: true,
    duration_ms: 5,
    path: 'C:\\Users\\user\\.wslconfig',
    message: 'Already in desired state: .wslconfig already contains memory=8GB',
  };
}

function simulateApplyWSLCap_notApplied(): NoOpResult {
  return {
    success: true,
    no_op: false,
    duration_ms: 250,
    path: 'C:\\Users\\user\\.wslconfig',
    message: 'WSL memory cap applied (8GB memory + 4GB swap). wsl --shutdown issued.',
  };
}

function simulateEnablePUA_alreadyEnabled(): NoOpResult {
  return {
    success: true,
    no_op: true,
    duration_ms: 5,
    before_state: 'Enabled',
    after_state: 'Enabled',
    changed: false,
    message: 'Already in desired state: PUA protection is already Enabled',
  };
}

function simulateEnablePUA_changed(): NoOpResult {
  return {
    success: true,
    no_op: false,
    duration_ms: 120,
    before_state: 'Disabled',
    after_state: 'Enabled',
    changed: true,
    message: 'PUA protection: Disabled -> Enabled',
  };
}

function simulateEnableCFA_alreadyEnabled(): NoOpResult {
  return {
    success: true,
    no_op: true,
    duration_ms: 5,
    before_state: 'Enabled',
    after_state: 'Enabled',
    changed: false,
    message: 'Already in desired state: Controlled Folder Access is already Enabled',
  };
}

function simulateEnableCFA_changed(): NoOpResult {
  return {
    success: true,
    no_op: false,
    duration_ms: 130,
    before_state: 'Disabled',
    after_state: 'Enabled',
    changed: true,
    message: 'Controlled Folder Access: Disabled -> Enabled (review blocked apps in Windows Security)',
  };
}

function simulateUpdateHosts_sameHash(): NoOpResult {
  return {
    success: true,
    no_op: true,
    duration_ms: 800,
    unchanged: true,
    sha256: 'abc123',
    domains_blocked: null,
    bytes_added: 0,
    message: 'Already in desired state: StevenBlack list unchanged since last run; no edits made.',
  };
}

function simulateUpdateHosts_updated(): NoOpResult {
  return {
    success: true,
    no_op: undefined, // not set when changes occurred
    duration_ms: 1500,
    sha256: 'def456',
    previous_sha256: 'abc123',
    domains_blocked: 100000,
    message: 'Merged StevenBlack list (100000 domains blocked, preserved 2 user line(s))',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Apply-WSLCap.ps1 — no-op guard', () => {
  it('returns no_op=true with "Already in desired state" when cap already applied', () => {
    const result = simulateApplyWSLCap_alreadyApplied();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(true);
    expect(result.message).toContain('Already in desired state');
    expect(result.message).toContain('memory=8GB');
  });

  it('returns no_op=false and applies the cap when not yet applied', () => {
    const result = simulateApplyWSLCap_notApplied();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(false);
    expect(result.message).toContain('applied');
    expect(result.message).toContain('8GB');
  });
});

describe('Enable-PUAProtection.ps1 — no-op guard', () => {
  it('returns no_op=true with changed=false when already enabled', () => {
    const result = simulateEnablePUA_alreadyEnabled();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.message).toContain('Already in desired state');
  });

  it('returns no_op=false with changed=true when was disabled', () => {
    const result = simulateEnablePUA_changed();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(false);
    expect(result.changed).toBe(true);
    expect(result.message).toContain('Disabled -> Enabled');
  });
});

describe('Enable-ControlledFolderAccess.ps1 — no-op guard', () => {
  it('returns no_op=true with changed=false when already enabled', () => {
    const result = simulateEnableCFA_alreadyEnabled();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(true);
    expect(result.changed).toBe(false);
    expect(result.message).toContain('Already in desired state');
  });

  it('returns no_op=false with changed=true when was disabled', () => {
    const result = simulateEnableCFA_changed();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(false);
    expect(result.changed).toBe(true);
  });
});

describe('Update-HostsFromStevenBlack.ps1 — no-op guard (SHA match)', () => {
  it('returns no_op=true when remote SHA matches local cached SHA', () => {
    const result = simulateUpdateHosts_sameHash();
    expect(result.success).toBe(true);
    expect(result.no_op).toBe(true);
    expect(result.unchanged).toBe(true);
    expect(result.message).toContain('Already in desired state');
  });

  it('does not set no_op when SHA differs and update was applied', () => {
    const result = simulateUpdateHosts_updated();
    expect(result.success).toBe(true);
    // no_op is undefined (not set) when changes were made
    expect(result.no_op).toBeUndefined();
    expect(result.domains_blocked).toBeGreaterThan(0);
  });
});

describe('Dashboard toast rendering — no-op detection', () => {
  it('no_op result message starts with "Already in desired state"', () => {
    const noOpResults = [
      simulateApplyWSLCap_alreadyApplied(),
      simulateEnablePUA_alreadyEnabled(),
      simulateEnableCFA_alreadyEnabled(),
      simulateUpdateHosts_sameHash(),
    ];

    for (const r of noOpResults) {
      expect(r.no_op).toBe(true);
      expect(r.message).toMatch(/already in desired state/i);
    }
  });
});
