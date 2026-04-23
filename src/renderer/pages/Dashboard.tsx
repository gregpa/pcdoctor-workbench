import { useState, useEffect, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { useStatus } from '@renderer/hooks/useStatus.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { useTrend } from '@renderer/hooks/useTrends.js';
import { useSecurityPosture } from '@renderer/hooks/useSecurityPosture.js';
import { useWeeklyReview } from '@renderer/hooks/useWeeklyReview.js';
import { useNavigate } from 'react-router-dom';
import { HeaderBar } from '@renderer/components/layout/HeaderBar.js';
import { KpiCard } from '@renderer/components/dashboard/KpiCard.js';
import { Gauge } from '@renderer/components/dashboard/Gauge.js';
import { ActionButton } from '@renderer/components/dashboard/ActionButton.js';
import { AlertCard } from '@renderer/components/dashboard/AlertCard.js';
import { AlertDetailModal } from '@renderer/components/dashboard/AlertDetailModal.js';
import type { Finding, Trend } from '@shared/types.js';
import { TrendLine } from '@renderer/components/dashboard/TrendLine.js';
import { TrendLineModal } from '@renderer/components/dashboard/TrendLineModal.js';
import { TrendBar } from '@renderer/components/dashboard/TrendBar.js';
import { EventLogDetailModal } from '@renderer/components/dashboard/EventLogDetailModal.js';
import { SmartTable } from '@renderer/components/dashboard/SmartTable.js';
import { AuthEventsWidget } from '@renderer/components/dashboard/AuthEventsWidget.js';
import { BsodPanel } from '@renderer/components/dashboard/BsodPanel.js';
import { ServicePill } from '@renderer/components/dashboard/ServicePill.js';
import { ServiceDetailModal } from '@renderer/components/dashboard/ServiceDetailModal.js';
import { DiskSmartDetailModal } from '@renderer/components/dashboard/DiskSmartDetailModal.js';
import { SecurityDetailModal, type SecurityDetailKind } from '@renderer/components/dashboard/SecurityDetailModal.js';
import { CleanMyPC } from '@renderer/components/dashboard/CleanMyPC.js';
import { TodaysActionsWidget } from '@renderer/components/dashboard/TodaysActionsWidget.js';
import { ActionResultModal } from '@renderer/components/dashboard/ActionResultModal.js';
import { StartupPickerModal } from '@renderer/components/dashboard/StartupPickerModal.js';
import { RamPressurePanel } from '@renderer/components/dashboard/RamPressurePanel.js';
import { NasRecycleBinPanel } from '@renderer/components/dashboard/NasRecycleBinPanel.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionDefinition } from '@shared/actions.js';
import { recommendAction, getTopRecommendations } from '@shared/recommendations.js';
import type { ActionName, ServiceHealth, SmartEntry } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { logPerf } from '@renderer/lib/perfLog.js';

const QUICK_ACTIONS: ActionName[] = [
  'clear_temp_files', 'flush_dns',
  'rebuild_search_index', 'run_sfc',
  'run_dism', 'remap_nas',
  'compact_docker', 'trim_ssd',
  'apply_wsl_cap', 'restart_explorer',
  'flush_arp_cache', 'clear_stale_pending_renames',
  'kill_process',
];

const DEEP_CLEAN_ACTIONS: ActionName[] = [
  'clear_browser_caches',
  'shrink_component_store',
  'remove_feature_update_leftovers',
  'empty_recycle_bins',
];

const HARDEN_ACTIONS: ActionName[] = [
  'enable_pua_protection',
  'enable_controlled_folder_access',
  'update_hosts_stevenblack',
  'defender_full_scan',
  'open_windows_security',
];

// v2.4.26: SecRow is now clickable. When onClick is provided the row
// becomes a button with hover styling; otherwise it stays static for
// back-compat with any places SecRow might be rendered without interaction.
function SecRow({
  label, tone, right, onClick,
}: {
  label: string;
  tone?: 'good' | 'warn' | 'crit' | 'info';
  right: string;
  onClick?: () => void;
}) {
  const toneClass = tone === 'crit' ? 'text-status-crit' : tone === 'warn' ? 'text-status-warn' : tone === 'good' ? 'text-status-good' : 'text-text-secondary';
  const dot = tone === 'crit' ? 'bg-status-crit' : tone === 'warn' ? 'bg-status-warn' : 'bg-status-good';
  const baseClasses = 'flex items-center justify-between gap-2 w-full text-left';
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseClasses} py-0.5 rounded hover:bg-surface-700/40 hover:translate-x-0.5 transition`}
        title={`Open ${label} detail`}
      >
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
          <span>{label}</span>
        </div>
        <span className={`text-[10px] ${toneClass}`}>{right}</span>
      </button>
    );
  }
  return (
    <div className={baseClasses}>
      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${dot}`}></span>
        <span>{label}</span>
      </div>
      <span className={`text-[10px] ${toneClass}`}>{right}</span>
    </div>
  );
}

export function Dashboard() {
  const { status, error, loading, refetch } = useStatus();
  const { run, running } = useAction({
    autoRefresh: true,
    onRefresh: () => { void refetch(); },
  });
  const { trend: cpuTrend } = useTrend('cpu', 'load_pct', 7);
  const { trend: eventsTrend } = useTrend('events', 'system_count', 7);
  // v2.4.29: temperature trends - populated once temperatures metric
  // rows are recorded via pcdoctorBridge's readTemperaturesBestEffort.
  const { trend: cpuTempTrend } = useTrend('cpu', 'temp_c', 7);
  const { trend: gpuTempTrend } = useTrend('gpu', 'temp_c', 7);
  const { data: security, refresh: refreshSecurity } = useSecurityPosture();
  const { review: weeklyReview } = useWeeklyReview();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(null);
  const [toastVariant, setToastVariant] = useState<'default' | 'noop' | 'error' | 'admin'>('default');
  const [selectedService, setSelectedService] = useState<ServiceHealth | null>(null);
  // v2.4.25: click a Disk SMART Health row for the detail modal.
  const [selectedSmartDrive, setSelectedSmartDrive] = useState<SmartEntry | null>(null);
  // v2.4.26: click any Security & Updates row for its detail modal.
  const [selectedSecurityKind, setSelectedSecurityKind] = useState<SecurityDetailKind | null>(null);
  const [scanning, setScanning] = useState(false);
  const [resultModal, setResultModal] = useState<{ action: ActionDefinition; result: Record<string, unknown> } | null>(null);
  const [showStartupPicker, setShowStartupPicker] = useState(false);
  // v2.4.39 (B49): state now carries the actual trend object clicked.
  // Prior shape was `{title, unit, yDomain}` only, so the modal always
  // rendered cpuTrend regardless of which tile was clicked (CPU Temp +
  // GPU Temp expansions silently showed CPU Load data with a fake °C
  // label). Threading the trend through state fixes that.
  const [expandedTrend, setExpandedTrend] = useState<null | { title: string; trend: Trend; unit: string; yDomain?: [number, number] }>(null);
  // v2.4.13: bump after a NAS @Recycle empty so the panel re-fetches sizes.
  const [nasRefreshToken, setNasRefreshToken] = useState(0);
  // v2.4.6: Event Log chart click-to-expand. Opens a modal that fetches
  // Get-EventLogBreakdown.ps1 on demand and lists the top providers/IDs.
  const [showEventLogDetail, setShowEventLogDetail] = useState(false);
  // v2.4.6: active alert detail modal. Hoisted to Dashboard so the modal
  // is a sibling of the alert list (not a child of the clicked card),
  // preventing click-bubble / hover flash cycles.
  const [activeAlertDetail, setActiveAlertDetail] = useState<Finding | null>(null);
  const [lastActionSuccess, setLastActionSuccess] = useState<Record<string, number>>({});

  // Pull the action_name -> last-success-ts map so recommendations show
  // "Last emptied Xd ago" instead of "Never emptied" after a successful run.
  const refreshLastSuccess = useCallback(async () => {
    const r = await (api as any).getLastActionSuccessMap?.();
    if (r?.ok) setLastActionSuccess(r.data);
  }, []);
  useEffect(() => { refreshLastSuccess(); }, [refreshLastSuccess]);

  // v2.4.38: log every Dashboard render so we can detect render storms
  // during a resize drag once the window is unlocked in v2.4.39. One
  // line per render, tagged with the finding count + loading state so
  // the log is self-describing. Does NOT gate on changes -- every
  // render emits a line, which is the point (we want to count them).
  useEffect(() => {
    logPerf('Dashboard.render', 0, {
      findings: status?.findings.length ?? 0,
      loading: loading ? 1 : 0,
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    });
  });
  // Refresh the map whenever an action completes (useAction dispatches
  // statusRefreshed after its post-action scan finishes).
  useEffect(() => {
    const h = () => { refreshLastSuccess(); };
    window.addEventListener('statusRefreshed', h);
    return () => window.removeEventListener('statusRefreshed', h);
  }, [refreshLastSuccess]);

  const getLastRun = useCallback((actionName: ActionName): number | null => {
    const ms = lastActionSuccess[actionName];
    return ms ? Math.floor(ms / 1000) : null; // recommendations takes seconds
  }, [lastActionSuccess]);

  async function handleRunScanNow() {
    if (scanning) return;
    setScanning(true);
    const beforeTs = status?.generated_at ?? 0;
    const r = await api.runScheduledTaskNow('PCDoctor-Daily-Quick');
    if (!r.ok) {
      setToast(`Scan failed to start: ${r.error?.message ?? 'unknown'}`);
      setTimeout(() => setToast(null), 5000);
      setScanning(false);
      return;
    }
    setToast('Scan running in background - refreshing when done...');
    // Poll every 3s up to 5 min waiting for latest.json timestamp to advance
    const deadline = Date.now() + 5 * 60 * 1000;
    const tick = async () => {
      if (Date.now() > deadline) {
        setToast('Scan did not finish within 5 min - will refresh when it does');
        setScanning(false);
        setTimeout(() => setToast(null), 5000);
        return;
      }
      const fresh = await refetch();
      if (fresh && fresh.generated_at > beforeTs) {
        // v2.4.6: Scan Now also re-fetches the security posture so Harden
        // recommendations reflect live state (previously cached from first
        // mount, so PUA/CFA changes required an app restart to surface).
        void refreshSecurity();
        setScanning(false);
        setToast(`Scan complete · ${fresh.findings.length} findings`);
        setTimeout(() => setToast(null), 5000);
        return;
      }
      setTimeout(tick, 3000);
    };
    setTimeout(tick, 3000);
  }

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Loading diagnostic data…</span>
    </div>
  );
  if (error || !status) {
    return (
      <div className="p-6">
        <div className="bg-status-warn/10 border border-status-warn/40 rounded-lg p-4 text-sm">
          <div className="font-semibold text-status-warn mb-1">⚠ No diagnostic report available</div>
          <div className="text-text-secondary">{error?.message ?? 'Run a scan to generate one.'}</div>
        </div>
      </div>
    );
  }

  async function handleAction(name: ActionName, params?: Record<string, string>, dryRun?: boolean) {
    const err = await run({ name, params, dry_run: dryRun });
    if (err) {
      if (err.code === 'E_NEEDS_ADMIN') {
        setToastVariant('admin');
        setToast(`${ACTIONS[name].label} requires Admin — relaunch Workbench as Administrator.`);
      } else if (err.code === 'E_TAMPER_PROTECTION') {
        // v2.4.4: Tamper Protection blocks Set-MpPreference. Auto-open the
        // Windows Security UI so the user can toggle the setting there.
        setToastVariant('admin');
        setToast(`${ACTIONS[name].label} is blocked by Windows Tamper Protection. Opening Windows Security...`);
        await handleAction('open_windows_security');
      } else if (err.code === 'E_UAC_DISABLED') {
        setToastVariant('admin');
        setToast(`${ACTIONS[name].label} failed: UAC is disabled. Re-enable UAC (Security → UAC detail) + reboot.`);
      } else {
        setToastVariant('error');
        setToast(`${ACTIONS[name].label} failed: ${err.message}`);
      }
    } else {
      // Check if last result was a no-op
      const result = (window as any).__lastActionResult as { no_op?: boolean; message?: string } | undefined;
      if (result?.no_op) {
        setToastVariant('noop');
        setToast(`Already in desired state — no change needed${result.message ? `: ${result.message}` : ''}`);
      } else {
        setToastVariant('default');
        setToast(`${ACTIONS[name].label}${dryRun ? ' (dry run)' : ''} completed`);
        // v2.3.0 B1: open the result modal for informational actions so the user
        // sees the rich breakdown instead of just a success toast.
        if (ACTIONS[name].informational && !dryRun && result && !result.no_op) {
          setResultModal({ action: ACTIONS[name], result: result as Record<string, unknown> });
        }
      }
    }
    setTimeout(() => setToast(null), 4000);
  }

  const subtitle = `${new Date(status.generated_at * 1000).toLocaleString()} · Polling every 60 s`;

  return (
    <div className="p-3 min-h-screen bg-surface-900">
      <HeaderBar
        host={status.host}
        severity={status.overall_severity}
        label={status.overall_label}
        subtitle={subtitle}
        onScan={handleRunScanNow}
        scanning={scanning}
      />

      {weeklyReview?.has_pending_flag && (
        <div
          onClick={() => navigate('/weekly-review')}
          className="mb-3 p-3 bg-status-info/10 border border-status-info/40 rounded-lg cursor-pointer hover:border-status-info/60 flex items-center justify-between gap-3 transition"
        >
          <div className="flex items-center gap-2">
            <span>📋</span>
            <div>
              <div className="text-sm font-semibold text-status-info">Weekly review ready</div>
              <div className="text-[11px] text-text-secondary">{weeklyReview.review_date} · {weeklyReview.action_items.length} action items</div>
            </div>
          </div>
          <span className="text-xs text-status-info">Open →</span>
        </div>
      )}

      {/* KPI row -- v2.4.39 (B45) responsive:
          <640px: 2 cols (phones/very narrow) | 640-1024: 3 cols |
          1024+: 6 cols (original design width). */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-3">
        {status.kpis.slice(0, 6).map((k) => (<KpiCard key={k.label} kpi={k} />))}
      </div>

      {/* Gauges + 7-day trend
         v2.3.0 C3: when RAM > 75% we swap the simple RAM gauge for the deeper
         RamPressurePanel. Under 75%, keep the existing compact gauge layout. */}
      {(() => {
        const ramKpi = status.kpis.find(k => k.label?.toLowerCase().includes('ram') && k.unit === '%');
        const ramPct = typeof ramKpi?.value === 'number' ? ramKpi.value : 0;
        const showPanel = ramPct > 75;
        const gaugesToShow = showPanel
          ? status.gauges.filter(g => !g.label.toLowerCase().includes('ram')).slice(0, 2)
          : status.gauges.slice(0, 3);
        return (
          // v2.4.39 (B45): gauges stack vertically below md, 2-up at md, 3-up at lg.
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2.5 mb-3">
            {gaugesToShow.map((g) => {
              // v2.4.40 (B52): CPU gauge click-to-expand removed. The CPU
              // Load 7-day trend chart is literally the next tile in the
              // row below; opening the same modal from the gauge was
              // redundant UI clutter. Gauges are now all non-clickable
              // data displays.
              return (
                <div
                  key={g.label}
                  className="bg-surface-800 border border-surface-600 rounded-lg p-3"
                >
                  <Gauge label={g.label} value={g.value} display={g.display} subtext={g.subtext} severity={g.severity} />
                </div>
              );
            })}
            {showPanel && (
              <RamPressurePanel status={status} onKillProcess={(name) => handleAction('kill_process', { target: name })} />
            )}
          </div>
        );
      })()}

      {/* v2.4.29: three trend charts in their own row - CPU load, CPU
         temp, GPU temp. Replaces the v2.4.28 TemperaturePanel per user
         request ("make them trends just like the CPU load. fill out
         that row"). Drive temps removed here - they're already in the
         Disk SMART Health section. */}
      <div className="mb-1.5 flex justify-between items-center">
        <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold">7-day trends</div>
        <button
          onClick={() => void handleAction('refresh_temperatures')}
          className="text-[10px] text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
          title="Run Get-Temperatures elevated. CPU thermal-zone WMI needs admin; this caches the read so subsequent scans populate the CPU temp trend without UAC."
        >
          🌡 Refresh CPU Temp (admin)
        </button>
      </div>
      {/* v2.4.39 (B45): trend charts need width to be legible -- stack below
          lg rather than squeezing 3-up too narrow. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 mb-3">
        {cpuTrend ? (
          <TrendLine
            title="CPU Load - 7 Day Trend"
            trend={cpuTrend}
            severity="info"
            yDomain={[0, 100]}
            onExpand={() => cpuTrend && setExpandedTrend({ title: 'CPU Load - 7 Day Trend', trend: cpuTrend, unit: '%', yDomain: [0, 100] })}
          />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering CPU load trend…</div>
        )}
        {cpuTempTrend ? (
          <TrendLine
            title="CPU Temp - 7 Day Trend"
            trend={cpuTempTrend}
            severity="info"
            yDomain={[30, 100]}
            onExpand={() => cpuTempTrend && setExpandedTrend({ title: 'CPU Temp - 7 Day Trend', trend: cpuTempTrend, unit: '°C', yDomain: [30, 100] })}
          />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex flex-col items-center justify-center text-text-secondary text-xs gap-2">
            <div>CPU temp trend</div>
            <div className="text-[10px] italic">admin required to seed - click Refresh above</div>
          </div>
        )}
        {gpuTempTrend ? (
          <TrendLine
            title="GPU Temp - 7 Day Trend"
            trend={gpuTempTrend}
            severity="info"
            yDomain={[30, 100]}
            onExpand={() => gpuTempTrend && setExpandedTrend({ title: 'GPU Temp - 7 Day Trend', trend: gpuTempTrend, unit: '°C', yDomain: [30, 100] })}
          />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering GPU temp trend…</div>
        )}
      </div>

      {/* v2.4.29: the v2.4.28 TemperaturePanel was replaced by three
         trend charts above (CPU load + CPU temp + GPU temp). Drive
         temps removed entirely - they already live in the Disk SMART
         Health section, keeping that data non-duplicated. */}

      {/* v2.4.13: NAS drive storage + per-drive @Recycle empty. Auto-discovers
         mapped network drives via Get-NasDrives.ps1; shows offline ones
         grayed out with a reachable=false flag. Per-drive confirm button
         only (no "empty all" to avoid misclicks across 14 TB shares). */}
      <NasRecycleBinPanel
        refreshToken={nasRefreshToken}
        onEmptyDrive={async (letter) => {
          // v2.4.16: actionRunner does snake_case -> PascalCase properly,
          // so 'drive_letter' -> '-DriveLetter' -> $DriveLetter PS param.
          await handleAction('empty_nas_recycle_bin', { drive_letter: letter });
          setNasRefreshToken((t) => t + 1);
        }}
      />

      <TodaysActionsWidget status={status} />

      <div className="mb-3">
        <CleanMyPC status={status} />
      </div>

      {/* Deep Clean & Harden - v2.1.4 */}
      {(() => {
        const deepCleanTop = getTopRecommendations(DEEP_CLEAN_ACTIONS, status, security, getLastRun);
        const hardenTop = getTopRecommendations(HARDEN_ACTIONS, status, security, getLastRun);
        const hardenOffCount = security?.defender
          ? [
              !security.defender.puaprotection || security.defender.puaprotection === 'Disabled' || security.defender.puaprotection === '0',
              !security.defender.controlled_folder_access || security.defender.controlled_folder_access === 'Disabled' || security.defender.controlled_folder_access === '0',
              !security.defender.network_protection || security.defender.network_protection === 'Disabled' || security.defender.network_protection === '0',
            ].filter(Boolean).length
          : 0;

        return (
          // v2.4.39 (B45): Deep Clean + Harden stack below lg so each gets
          // full width for readability on narrow windows.
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5 mb-3">
            {/* Deep Clean panel */}
            <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
              <div className="mb-2">
                <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold flex items-center gap-1">
                  <span>🧽</span><span>Deep Clean</span>
                </div>
                <div className="text-[9px] text-text-secondary mt-0.5">
                  {deepCleanTop.length > 0
                    ? `${deepCleanTop.length} recommended now`
                    : 'All clean — nothing urgent'}
                </div>
              </div>
              {/* Suggested now strip */}
              {deepCleanTop.length > 0 && (
                <div className="mb-2 space-y-1">
                  {deepCleanTop.map(({ action: name, rec }) => (
                    <button
                      key={name}
                      onClick={() => handleAction(name)}
                      disabled={running !== null}
                      className="w-full flex items-center gap-1.5 px-2 py-1 bg-status-good/10 border border-status-good/30 rounded text-[10px] text-status-good hover:bg-status-good/20 transition disabled:opacity-50"
                    >
                      <span>💡</span>
                      <span className="font-semibold">{ACTIONS[name].label}</span>
                      <span className="text-text-secondary truncate">— {rec.reason}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {DEEP_CLEAN_ACTIONS.map((name) => (
                  <ActionButton
                    key={name}
                    action={ACTIONS[name]}
                    onRun={(params, dryRun) => handleAction(name, params, dryRun)}
                    disabled={running !== null}
                    recommendation={recommendAction(name, status, security, getLastRun)}
                  />
                ))}
              </div>
            </div>

            {/* Harden panel */}
            <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
              <div className="mb-2">
                <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold flex items-center gap-1">
                  <span>🛡</span><span>Harden</span>
                </div>
                <div className="text-[9px] text-text-secondary mt-0.5">
                  {hardenOffCount > 0
                    ? `${hardenOffCount} protection${hardenOffCount === 1 ? '' : 's'} off`
                    : 'All protections enabled'}
                </div>
              </div>
              {/* Suggested now strip */}
              {hardenTop.length > 0 && (
                <div className="mb-2 space-y-1">
                  {hardenTop.map(({ action: name, rec }) => (
                    <button
                      key={name}
                      onClick={() => handleAction(name)}
                      disabled={running !== null}
                      className="w-full flex items-center gap-1.5 px-2 py-1 bg-status-good/10 border border-status-good/30 rounded text-[10px] text-status-good hover:bg-status-good/20 transition disabled:opacity-50"
                    >
                      <span>💡</span>
                      <span className="font-semibold">{ACTIONS[name].label}</span>
                      <span className="text-text-secondary truncate">— {rec.reason}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-1.5">
                {HARDEN_ACTIONS.map((name) => (
                  <ActionButton
                    key={name}
                    action={ACTIONS[name]}
                    onRun={(params, dryRun) => handleAction(name, params, dryRun)}
                    disabled={running !== null}
                    recommendation={recommendAction(name, status, security, getLastRun)}
                  />
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Services + Actions + Alerts row -- v2.4.39 (B45): stacks below lg
          so each of the three panels has full width on narrow windows. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5 mb-3">
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">Services & Processes</div>
          {/* v2.4.39 (B45): service pills widen to 2-up on phones, 3-up at sm
              so pill text has room to breathe instead of clipping to "S..." */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
            {(status.services ?? []).slice(0, 9).map((s) => (
              <ServicePill key={s.key} service={s} onClick={setSelectedService} />
            ))}
          </div>
        </div>

        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2 flex items-center gap-1">
            <span>⚡</span><span>One-Click Actions</span>
          </div>
          {/* v2.4.39 (B45): reduce min-tile width from 120 -> 100 so the
              auto-fill grid can fit more on narrow widths without
              dropping a tile off the row entirely. */}
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))' }}>
            {QUICK_ACTIONS.map((name) => (
              <ActionButton key={name} action={ACTIONS[name]} onRun={(params, dryRun) => handleAction(name, params, dryRun)} disabled={running !== null} recommendation={recommendAction(name, status, security, getLastRun)} />
            ))}
          </div>
        </div>

        <div id="active-alerts" className="bg-surface-800 border border-surface-600 rounded-lg p-3 transition-all duration-500 scroll-mt-4">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
            Active Alerts {status.findings.length > 0 ? `(${status.findings.length})` : ''}
          </div>
          <div className="space-y-2">
            {status.findings.length === 0 && <div className="text-xs text-text-secondary">No active findings. System healthy.</div>}
            {status.findings.map((f, i) => (
              <AlertCard
                key={i}
                finding={f}
                onOpenDetail={setActiveAlertDetail}
                onApply={async (name, params) => {
                  if (name === 'disable_startup_item') {
                    setShowStartupPicker(true);
                    return;
                  }
                  await handleAction(name, params);
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* SMART + Event log chart + Security stub
          v2.4.39 (B45): stacks below lg. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-2.5">
        <SmartTable
          entries={status.smart ?? []}
          onRunSmartCheck={async () => {
            // v2.4.18: elevate + run SMART check, then refresh the
            // Security posture so the cache merge in Get-SMART.ps1
            // picks up the fresh wear/temp values on the next Dashboard
            // render. Without refreshSecurity(), the user would see no
            // change until a full Scan Now.
            await handleAction('run_smart_check');
            await refreshSecurity();
          }}
          onRowClick={setSelectedSmartDrive}
        />
        {eventsTrend ? (
          <TrendBar
            title="Event Log Errors - 7 Day"
            trend={eventsTrend}
            warnAt={300}
            critAt={500}
            onExpand={() => setShowEventLogDetail(true)}
            expandHint="Click to see which providers and event IDs are driving the count"
          />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering event trend…</div>
        )}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">Security & Updates</div>
          {security ? (
            <div className="space-y-1.5 text-[11px]">
              <SecRow label="Windows Defender" tone={security.defender?.severity} right={security.defender?.realtime_protection ? `Active · Defs ${security.defender.defs_age_hours}h` : 'Disabled'} onClick={() => setSelectedSecurityKind('defender')} />
              <SecRow label="Windows Firewall" tone={security.firewall?.severity} right={security.firewall && security.firewall.domain_enabled && security.firewall.private_enabled && security.firewall.public_enabled ? 'All profiles enabled' : 'Partial'} onClick={() => setSelectedSecurityKind('firewall')} />
              <SecRow label="Windows Update" tone={security.windows_update?.severity} right={security.windows_update ? `${security.windows_update.pending_count} pending${security.windows_update.pending_security_count > 0 ? ` (${security.windows_update.pending_security_count} security)` : ''}` : '-'} onClick={() => setSelectedSecurityKind('windows_update')} />
              <SecRow label={`Failed Logins (7d)`} tone={security.failed_logins?.severity} right={`${security.failed_logins?.total_7d ?? 0} events`} onClick={() => setSelectedSecurityKind('failed_logins')} />
              <SecRow label="BitLocker" tone={security.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'} right={security.bitlocker.some(b => b.protection_on) ? `${security.bitlocker.filter(b => b.protection_on).length} protected` : 'Off - drives unencrypted'} onClick={() => setSelectedSecurityKind('bitlocker')} />
              <SecRow label="UAC" tone={security.uac?.severity} right={security.uac?.enabled ? (security.uac.level === 'Disabled' ? 'Disabled' : 'Enabled') : 'DISABLED'} onClick={() => setSelectedSecurityKind('uac')} />
              <SecRow label="GPU Driver" tone={security.gpu_driver?.severity} right={security.gpu_driver ? `${security.gpu_driver.gpu_current_version}${security.gpu_driver.age_days !== null ? ` - ${security.gpu_driver.age_days}d old` : ''}` : '-'} onClick={() => setSelectedSecurityKind('gpu_driver')} />
              {security.persistence_new_count > 0 && (
                <div className="pt-2 mt-2 border-t border-surface-700 text-[10px] text-status-warn">
                  ⚠ {security.persistence_new_count} new persistence item{security.persistence_new_count === 1 ? '' : 's'} - review in Security page
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-text-secondary">Loading security posture…</div>
          )}
        </div>
      </div>

      {/* v2.4.39 (B45): AuthEvents + BsodPanel stack below md. */}
      <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2.5">
        <AuthEventsWidget />
        <BsodPanel />
      </div>

      {selectedService && (
        <ServiceDetailModal
          service={selectedService}
          actionBusy={running !== null}
          onClose={() => setSelectedService(null)}
          onRestart={async (serviceKey) => {
            setSelectedService(null);
            // v2.4.25: params key 'service_name' -> '-ServiceName' via
            // actionRunner's snake->Pascal transform (v2.4.16). The PS
            // script's $ServiceName param matches.
            await handleAction('restart_service', { service_name: serviceKey });
          }}
        />
      )}

      {selectedSmartDrive && (
        <DiskSmartDetailModal
          entry={selectedSmartDrive}
          onClose={() => setSelectedSmartDrive(null)}
          onRunSmartCheck={async () => {
            setSelectedSmartDrive(null);
            await handleAction('run_smart_check');
            await refreshSecurity();
          }}
        />
      )}

      {selectedSecurityKind && security && (
        <SecurityDetailModal
          kind={selectedSecurityKind}
          posture={security}
          onClose={() => setSelectedSecurityKind(null)}
          onDefenderQuickScan={async () => {
            setSelectedSecurityKind(null);
            await handleAction('defender_quick_scan');
            await refreshSecurity();
          }}
          onUpdateDefenderDefs={async () => {
            setSelectedSecurityKind(null);
            await handleAction('update_defender_defs');
            await refreshSecurity();
          }}
          onOpenWindowsSecurity={async () => {
            setSelectedSecurityKind(null);
            await handleAction('open_windows_security');
          }}
          onOpenFirewallConsole={async () => {
            setSelectedSecurityKind(null);
            await handleAction('open_firewall_console');
          }}
          onOpenUpdatesPage={() => {
            setSelectedSecurityKind(null);
            navigate('/updates');
          }}
          onUnblockIP={async (ip) => {
            await handleAction('unblock_ip', { ip });
            await refreshSecurity();
          }}
          onOpenNvidiaApp={async () => {
            setSelectedSecurityKind(null);
            await handleAction('open_nvidia_app');
          }}
        />
      )}

      {resultModal && (
        <ActionResultModal
          action={resultModal.action}
          result={resultModal.result}
          onClose={() => setResultModal(null)}
        />
      )}

      {showStartupPicker && (
        <StartupPickerModal
          items={status.metrics?.startup_items ?? []}
          onClose={() => setShowStartupPicker(false)}
          onDisable={async (picks) => {
            setShowStartupPicker(false);
            await handleAction('disable_startup_items_batch', { items_json: JSON.stringify(picks) });
          }}
        />
      )}

      {expandedTrend && (
        <TrendLineModal
          title={expandedTrend.title}
          trend={expandedTrend.trend}
          severity="info"
          unit={expandedTrend.unit}
          yDomain={expandedTrend.yDomain}
          onClose={() => setExpandedTrend(null)}
        />
      )}

      {showEventLogDetail && (
        <EventLogDetailModal onClose={() => setShowEventLogDetail(false)} />
      )}

      {activeAlertDetail && (() => {
        const f = activeAlertDetail;
        const actionDef = f.suggested_action ? ACTIONS[f.suggested_action] : undefined;
        const requiredParams = actionDef?.params_schema
          ? Object.entries(actionDef.params_schema).filter(([, s]) => s.required).map(([k]) => k)
          : [];
        const derivedParams: Record<string, string> | undefined = (() => {
          if (!actionDef?.params_schema || !f.detail || typeof f.detail !== 'object') return undefined;
          const d = f.detail as Record<string, unknown>;
          const out: Record<string, string> = {};
          for (const k of Object.keys(actionDef.params_schema)) {
            const v = d[k];
            if (v != null) out[k] = String(v);
          }
          return Object.keys(out).length > 0 ? out : undefined;
        })();
        const missingParams = requiredParams.filter(k => !derivedParams || !derivedParams[k]);
        const canAutoFix = !!actionDef && missingParams.length === 0;
        const rec = f.suggested_action ? recommendAction(f.suggested_action, status, security) : null;
        const blockedReason = rec?.level === 'blocked' ? rec.reason : undefined;
        return (
          <AlertDetailModal
            finding={f}
            actionDef={actionDef}
            blockedReason={blockedReason}
            canAutoFix={canAutoFix}
            missingParams={missingParams}
            onClose={() => setActiveAlertDetail(null)}
            onFix={async () => {
              if (!f.suggested_action) return;
              if (f.suggested_action === 'disable_startup_item') {
                setShowStartupPicker(true);
                return;
              }
              await handleAction(f.suggested_action, derivedParams);
            }}
            onDismiss={() => setActiveAlertDetail(null)}
            onInvestigateWithClaude={async () => {
              const ctx = actionDef
                ? `Investigate this alert:\n- Area: ${f.area}\n- Severity: ${f.severity}\n- Message: ${f.message}\n- Auto-fixed: ${f.auto_fixed}\n\nExplain the root cause, describe what the "${actionDef.label}" action would do, and recommend whether to run it.`
                : `Investigate this alert:\n- Area: ${f.area}\n- Severity: ${f.severity}\n- Message: ${f.message}\n\nExplain what this means, why it matters, and what options the user has.`;
              await (window as any).api.investigateWithClaude(ctx);
              setActiveAlertDetail(null);
            }}
          />
        );
      })()}

      {toast && (
        <div className={`fixed bottom-4 right-4 rounded-lg px-4 py-3 text-sm shadow-xl flex items-center gap-3 ${
          toastVariant === 'noop' ? 'bg-status-info/10 border border-status-info/40 text-status-info' :
          toastVariant === 'error' ? 'bg-status-crit/10 border border-status-crit/40 text-status-crit' :
          toastVariant === 'admin' ? 'bg-status-warn/10 border border-status-warn/40 text-status-warn' :
          'bg-surface-700 border border-surface-600'
        }`}>
          <span>{toast}</span>
          {toastVariant === 'admin' && (
            <button
              onClick={async () => {
                setToast(null);
                await (window as any).api.relaunchAsAdmin();
              }}
              className="ml-2 px-2 py-1 rounded text-[11px] font-semibold bg-status-warn text-black shrink-0"
            >
              Relaunch as Admin
            </button>
          )}
        </div>
      )}
    </div>
  );
}
