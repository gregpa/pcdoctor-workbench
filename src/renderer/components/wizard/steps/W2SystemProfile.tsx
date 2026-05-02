/**
 * W2 System Profile — second step of the first-run wizard (index 1).
 *
 * Auto-detects hardware via Get-SystemProfile.ps1 (IPC), displays a
 * card grid of detected components, and lets the user configure
 * temperature/memory alert thresholds before proceeding.
 */

import { useEffect, useState, useCallback } from 'react';
import { useWizard } from '../WizardContext.js';
import type { SystemProfile } from '@shared/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatVram(bytes: number | null | undefined): string {
  if (bytes == null) return 'Unknown';
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HwCard({
  icon,
  label,
  value,
  detail,
  detected,
}: {
  icon: string;
  label: string;
  value: string | null;
  detail?: string | null;
  detected: boolean;
}) {
  return (
    <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3 flex items-start gap-3">
      <span className="text-xl leading-none mt-0.5">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
            {label}
          </span>
          {detected ? (
            <span className="text-status-good text-xs" aria-label="detected">
              {'✓'}
            </span>
          ) : (
            <span className="text-status-warn text-xs">Not detected</span>
          )}
        </div>
        {detected && value ? (
          <>
            <p className="text-sm text-text-primary truncate mt-0.5">{value}</p>
            {detail && (
              <p className="text-xs text-text-secondary mt-0.5">{detail}</p>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function ThresholdRow({
  label,
  unit,
  warnValue,
  critValue,
  onWarnChange,
  onCritChange,
}: {
  label: string;
  unit: string;
  warnValue: number;
  critValue: number;
  onWarnChange: (v: number) => void;
  onCritChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <span className="text-sm text-text-primary w-24 shrink-0">{label}</span>
      <div className="flex items-center gap-1.5">
        <label className="text-xs text-text-secondary">Warning</label>
        <input
          type="number"
          value={warnValue}
          onChange={(e) => onWarnChange(Number(e.target.value))}
          className="w-16 px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm text-center"
          aria-label={`${label} warning threshold`}
        />
        <span className="text-xs text-text-secondary">{unit}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <label className="text-xs text-text-secondary">Critical</label>
        <input
          type="number"
          value={critValue}
          onChange={(e) => onCritChange(Number(e.target.value))}
          className="w-16 px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm text-center"
          aria-label={`${label} critical threshold`}
        />
        <span className="text-xs text-text-secondary">{unit}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W2SystemProfile() {
  const { dispatch, markComplete } = useWizard();

  // Profile fetch state
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<SystemProfile | null>(null);

  // Threshold local state (persisted to settings on step completion)
  const [cpuTempWarn, setCpuTempWarn] = useState(80);
  const [cpuTempCrit, setCpuTempCrit] = useState(90);
  const [gpuTempWarn, setGpuTempWarn] = useState(80);
  const [gpuTempCrit, setGpuTempCrit] = useState(85);
  const [ramWarnPct, setRamWarnPct] = useState(85);
  const [ramCritPct, setRamCritPct] = useState(95);

  // Fetch system profile on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.api.getSystemProfile();
        if (cancelled) return;
        if (result.ok) {
          setProfile(result.data);
          dispatch({ type: 'SET_SYSTEM_PROFILE', payload: result.data });
        } else {
          setError(result.error?.message ?? 'Unknown error detecting hardware.');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to detect hardware.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dispatch]);

  // Save thresholds when the step is marked complete.
  // WizardShell calls markComplete before advancing; we intercept via
  // an exported helper that the shell can call, but since the shell
  // doesn't know about step-specific save logic, we instead listen
  // for the Next button by exposing a save function and calling it
  // in the parent. Simpler approach: save thresholds eagerly on any
  // change would be noisy. Instead we'll use a ref-based callback
  // that WizardShell can't see, so the pragmatic path is to save on
  // unmount (which fires when Next advances the step).
  const saveThresholds = useCallback(async () => {
    try {
      await Promise.all([
        window.api.setSetting('forecast_cpu_temp_warn', String(cpuTempWarn)),
        window.api.setSetting('forecast_cpu_temp_crit', String(cpuTempCrit)),
        window.api.setSetting('forecast_gpu_temp_warn', String(gpuTempWarn)),
        window.api.setSetting('forecast_gpu_temp_crit', String(gpuTempCrit)),
        window.api.setSetting('forecast_ram_warn_pct', String(ramWarnPct)),
        window.api.setSetting('forecast_ram_crit_pct', String(ramCritPct)),
      ]);
    } catch {
      // Non-fatal — settings can be adjusted later from the Settings page.
    }
  }, [cpuTempWarn, cpuTempCrit, gpuTempWarn, gpuTempCrit, ramWarnPct, ramCritPct]);

  // Save thresholds and mark step complete on unmount (step change).
  useEffect(() => {
    return () => {
      void saveThresholds();
      markComplete(1);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveThresholds]);

  // ── Loading state ──
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-4">
        <div className="w-8 h-8 border-2 border-status-info border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-text-secondary">Detecting your hardware&hellip;</p>
      </div>
    );
  }

  // ── Error state (non-blocking) ──
  if (error && !profile) {
    return (
      <div className="flex flex-col gap-4 py-4">
        <div className="rounded-lg border border-status-warn/30 bg-status-warn/10 px-4 py-3">
          <p className="text-sm text-status-warn">
            Could not detect hardware. You can configure thresholds manually in Settings later.
          </p>
          <p className="text-xs text-text-secondary mt-1">{error}</p>
        </div>
      </div>
    );
  }

  // ── Success state ──
  const p = profile!;

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* Header */}
      <div>
        <h2 className="text-lg font-bold text-text-primary">Your System</h2>
        <p className="text-sm text-text-secondary mt-0.5">
          We detected the following hardware.
        </p>
      </div>

      {/* Hardware grid */}
      <div className="grid grid-cols-2 gap-3">
        <HwCard
          icon={'\u{1F5A5}'}
          label="CPU"
          detected={p.cpu != null}
          value={p.cpu?.name ?? null}
          detail={p.cpu ? `${p.cpu.cores} cores / ${p.cpu.logical_processors} threads` : null}
        />
        <HwCard
          icon={'\u{1F4BE}'}
          label="RAM"
          detected={p.ram != null}
          value={p.ram ? `${p.ram.total_gb} GB` : null}
          detail={
            p.ram
              ? `${p.ram.dimm_count} DIMMs${p.ram.speed_mhz ? `, ${p.ram.speed_mhz} MHz` : ''}`
              : null
          }
        />
        <HwCard
          icon={'\u{1F3AE}'}
          label="GPU"
          detected={p.gpu != null}
          value={p.gpu?.name ?? null}
          detail={p.gpu ? `VRAM: ${formatVram(p.gpu.vram_bytes)}` : null}
        />
        <HwCard
          icon={'\u{1F4BB}'}
          label="Machine"
          detected={p.machine != null}
          value={p.machine ? `${p.machine.manufacturer} ${p.machine.model}` : null}
        />
        <HwCard
          icon={'\u{1FAA7}'}
          label="OS"
          detected={p.os != null}
          value={p.os?.caption ?? null}
          detail={p.os?.arch ?? null}
        />
        <HwCard
          icon={'\u{1F4BF}'}
          label="Drives"
          detected={p.drives.length > 0}
          value={`${p.drives.length} drive${p.drives.length !== 1 ? 's' : ''} detected`}
        />
      </div>

      {/* Threshold section */}
      <div className="mt-1">
        <h3 className="text-sm font-semibold text-text-primary">Alert Thresholds</h3>
        <p className="text-xs text-text-secondary mt-0.5 mb-3">
          When should PCDoctor alert you about temperatures and memory?
        </p>

        <div className="flex flex-col gap-3">
          <ThresholdRow
            label="CPU Temp"
            unit={'°C'}
            warnValue={cpuTempWarn}
            critValue={cpuTempCrit}
            onWarnChange={setCpuTempWarn}
            onCritChange={setCpuTempCrit}
          />
          <ThresholdRow
            label="GPU Temp"
            unit={'°C'}
            warnValue={gpuTempWarn}
            critValue={gpuTempCrit}
            onWarnChange={setGpuTempWarn}
            onCritChange={setGpuTempCrit}
          />
          <ThresholdRow
            label="RAM Usage"
            unit="%"
            warnValue={ramWarnPct}
            critValue={ramCritPct}
            onWarnChange={setRamWarnPct}
            onCritChange={setRamCritPct}
          />
        </div>
      </div>
    </div>
  );
}
