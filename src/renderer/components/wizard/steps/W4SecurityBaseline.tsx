/**
 * W4 Security Baseline — fourth step of the first-run wizard (index 3).
 *
 * Fetches the current security posture via getSecurityPosture(), displays
 * a card grid of Defender / Firewall / BitLocker / UAC status, offers to
 * add ProgramData\PCDoctor to Defender exclusions, and exposes an RDP
 * auto-block toggle whose default depends on detected failed-login counts.
 *
 * Settings written on unmount:
 *   - auto_block_rdp_bruteforce ('0' | '1')
 *   - defenderExclusionApplied via wizard state
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { useWizard } from '../WizardContext.js';
import type { SecurityPosture } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusCard({
  icon,
  label,
  value,
  detail,
  good,
}: {
  icon: string;
  label: string;
  value: string;
  detail?: string | null;
  good: boolean;
}) {
  return (
    <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3 flex items-start gap-3">
      <span className="text-xl leading-none mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {label}
          </span>
          {good ? (
            <span className="text-status-good text-xs" aria-label={`${label} good`}>
              {'✓'}
            </span>
          ) : (
            <span className="text-status-warn text-xs" aria-label={`${label} warning`}>
              {'⚠'}
            </span>
          )}
        </div>
        <p className="text-sm text-text-primary mt-0.5">{value}</p>
        {detail && (
          <p className="text-xs text-text-secondary mt-0.5">{detail}</p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defenderSummary(posture: SecurityPosture): { value: string; detail: string; good: boolean } {
  const d = posture.defender;
  if (!d) return { value: 'Not detected', detail: '', good: false };

  const rtLabel = d.realtime_protection ? 'On' : 'Off';
  const ageHours = d.defs_age_hours;
  const ageDays = Math.floor(ageHours / 24);
  const ageStr = ageDays > 0 ? `${ageDays} days old` : `${ageHours} hours old`;

  return {
    value: d.realtime_protection ? 'Enabled' : 'Disabled',
    detail: `Real-time: ${rtLabel} • Definitions: ${ageStr}`,
    good: d.realtime_protection && ageDays <= 7,
  };
}

function firewallSummary(posture: SecurityPosture): { value: string; good: boolean } {
  const f = posture.firewall;
  if (!f) return { value: 'Not detected', good: false };
  const allOn = f.domain_enabled && f.private_enabled && f.public_enabled;
  return {
    value: allOn ? 'All profiles active' : 'Some profiles disabled',
    good: allOn,
  };
}

function bitlockerSummary(posture: SecurityPosture): { value: string; good: boolean } {
  const vols = posture.bitlocker;
  if (!vols || vols.length === 0) return { value: 'Not configured', good: false };
  const encrypted = vols.filter((v) => v.status === 'FullyEncrypted').length;
  return {
    value: `${encrypted} of ${vols.length} volume${vols.length !== 1 ? 's' : ''} encrypted`,
    good: encrypted === vols.length,
  };
}

function uacSummary(posture: SecurityPosture): { value: string; good: boolean } {
  const u = posture.uac;
  if (!u) return { value: 'Not detected', good: false };
  return {
    value: u.enabled ? 'Enabled' : 'Disabled',
    good: u.enabled,
  };
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W4SecurityBaseline() {
  const { state, dispatch, markComplete } = useWizard();

  // Posture fetch state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [posture, setPosture] = useState<SecurityPosture | null>(null);

  // Defender exclusion state
  const [exclusionBusy, setExclusionBusy] = useState(false);
  const [exclusionError, setExclusionError] = useState<string | null>(null);
  const [exclusionApplied, setExclusionApplied] = useState(state.defenderExclusionApplied);

  // RDP auto-block toggle
  const [autoBlockRdp, setAutoBlockRdp] = useState(false);
  const rdpDefaultSet = useRef(false);

  // Fetch security posture on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.getSecurityPosture();
        if (cancelled) return;
        if (result.ok) {
          setPosture(result.data);
          // Default the RDP toggle based on failed login count
          if (!rdpDefaultSet.current) {
            const fl = result.data.failed_logins;
            const hasFailedLogins = fl != null && fl.total_7d > 0;
            setAutoBlockRdp(hasFailedLogins);
            rdpDefaultSet.current = true;
          }
        } else {
          setError(result.error?.message ?? 'Unknown error fetching security posture.');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to fetch security posture.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Apply Defender exclusion
  const handleApplyExclusion = useCallback(async () => {
    setExclusionBusy(true);
    setExclusionError(null);
    try {
      const r = await window.api.runAction({ name: 'add_pcdoctor_exclusion' });
      if (r.ok && r.data.success) {
        setExclusionApplied(true);
        dispatch({ type: 'SET_FIELD', field: 'defenderExclusionApplied', value: true });
      } else {
        const msg = r.ok
          ? r.data.error?.message ?? 'Action failed'
          : r.error?.message ?? 'IPC error';
        setExclusionError(msg);
      }
    } catch (e) {
      setExclusionError(e instanceof Error ? e.message : 'Unexpected error');
    } finally {
      setExclusionBusy(false);
    }
  }, [dispatch]);

  // Save settings and mark complete on unmount
  useEffect(() => {
    return () => {
      void window.api.setSetting('auto_block_rdp_bruteforce', autoBlockRdp ? '1' : '0');
      markComplete(3);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBlockRdp]);

  // ── Loading ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Checking security configuration&hellip;</p>
      </div>
    );
  }

  // ── Error (fatal — no posture at all) ──
  if (error && !posture) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3">
          <p className="text-sm text-status-warn">
            Could not retrieve security posture. You can review security status from the Security page later.
          </p>
          <p className="text-xs text-text-secondary mt-1">{error}</p>
        </div>
      </div>
    );
  }

  const p = posture!;
  const defender = defenderSummary(p);
  const firewall = firewallSummary(p);
  const bitlocker = bitlockerSummary(p);
  const uac = uacSummary(p);

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Security Baseline</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Your current security configuration.
        </p>
      </div>

      {/* Section 1: Security status grid */}
      <div className="grid grid-cols-2 gap-3">
        <StatusCard
          icon={'🛡'}
          label="Defender"
          value={defender.value}
          detail={defender.detail}
          good={defender.good}
        />
        <StatusCard
          icon={'🔥'}
          label="Firewall"
          value={firewall.value}
          good={firewall.good}
        />
        <StatusCard
          icon={'🔒'}
          label="BitLocker"
          value={bitlocker.value}
          good={bitlocker.good}
        />
        <StatusCard
          icon={'👤'}
          label="UAC"
          value={uac.value}
          good={uac.good}
        />
      </div>

      {/* Section 2: Defender exclusion */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <h3 className="text-sm font-semibold text-text-primary">Defender Exclusion</h3>
        <p className="text-xs text-text-secondary mt-1">
          Adding <code className="text-text-primary">C:\ProgramData\PCDoctor</code> to
          Defender exclusions eliminates scan overhead when PCDoctor reads and writes
          scanner data. This is safe because PCDoctor only stores its own diagnostic
          output in that folder.
        </p>

        {exclusionApplied ? (
          <p className="text-sm text-status-good mt-3">Exclusion applied successfully.</p>
        ) : (
          <div className="mt-3 flex items-center gap-3">
            <button
              onClick={handleApplyExclusion}
              disabled={exclusionBusy}
              className="px-4 py-1.5 rounded-md bg-status-info text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {exclusionBusy ? 'Applying…' : 'Apply (Recommended)'}
            </button>
            <span className="text-xs text-text-secondary">or skip by clicking Next</span>
          </div>
        )}

        {exclusionError && (
          <p className="text-xs text-status-crit mt-2">{exclusionError}</p>
        )}
      </div>

      {/* Section 3: RDP auto-block toggle */}
      <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-text-primary">Auto-Block RDP Brute Force</h3>
            <p className="text-xs text-text-secondary mt-1">
              Automatically block IP addresses that attempt RDP brute-force attacks.
              {posture?.failed_logins && posture.failed_logins.total_7d > 0 && (
                <span className="text-status-warn">
                  {' '}({posture.failed_logins.total_7d} failed login{posture.failed_logins.total_7d !== 1 ? 's' : ''} detected in the last 7 days)
                </span>
              )}
            </p>
          </div>
          <button
            role="switch"
            aria-checked={autoBlockRdp}
            aria-label="Auto-block RDP brute force"
            onClick={() => setAutoBlockRdp((v) => !v)}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${
              autoBlockRdp ? 'bg-status-info' : 'bg-surface-600'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                autoBlockRdp ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
