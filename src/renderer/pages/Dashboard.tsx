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
import type { Finding } from '@shared/types.js';
import { TrendLine } from '@renderer/components/dashboard/TrendLine.js';
import { TrendLineModal } from '@renderer/components/dashboard/TrendLineModal.js';
import { TrendBar } from '@renderer/components/dashboard/TrendBar.js';
import { EventLogDetailModal } from '@renderer/components/dashboard/EventLogDetailModal.js';
import { SmartTable } from '@renderer/components/dashboard/SmartTable.js';
import { AuthEventsWidget } from '@renderer/components/dashboard/AuthEventsWidget.js';
import { BsodPanel } from '@renderer/components/dashboard/BsodPanel.js';
import { ServicePill } from '@renderer/components/dashboard/ServicePill.js';
import { CleanMyPC } from '@renderer/components/dashboard/CleanMyPC.js';
import { TodaysActionsWidget } from '@renderer/components/dashboard/TodaysActionsWidget.js';
import { ActionResultModal } from '@renderer/components/dashboard/ActionResultModal.js';
import { StartupPickerModal } from '@renderer/components/dashboard/StartupPickerModal.js';
import { RamPressurePanel } from '@renderer/components/dashboard/RamPressurePanel.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionDefinition } from '@shared/actions.js';
import { recommendAction, getTopRecommendations } from '@shared/recommendations.js';
import type { ActionName, ServiceHealth } from '@shared/types.js';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

const QUICK_ACTIONS: ActionName[] = [
  'clear_temp_files', 'flush_dns',
  'rebuild_search_index', 'run_sfc',
  'run_dism', 'remap_nas',
  'compact_docker', 'trim_ssd',
  'apply_wsl_cap', 'restart_explorer',
  'flush_arp_cache', 'kill_process',
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

function SecRow({ label, tone, right }: { label: string; tone?: 'good' | 'warn' | 'crit' | 'info'; right: string }) {
  const toneClass = tone === 'crit' ? 'text-status-crit' : tone === 'warn' ? 'text-status-warn' : tone === 'good' ? 'text-status-good' : 'text-text-secondary';
  const dot = tone === 'crit' ? 'bg-status-crit' : tone === 'warn' ? 'bg-status-warn' : 'bg-status-good';
  return (
    <div className="flex items-center justify-between gap-2">
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
  const { data: security, refresh: refreshSecurity } = useSecurityPosture();
  const { review: weeklyReview } = useWeeklyReview();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(null);
  const [toastVariant, setToastVariant] = useState<'default' | 'noop' | 'error' | 'admin'>('default');
  const [selectedService, setSelectedService] = useState<ServiceHealth | null>(null);
  const [scanning, setScanning] = useState(false);
  const [resultModal, setResultModal] = useState<{ action: ActionDefinition; result: Record<string, unknown> } | null>(null);
  const [showStartupPicker, setShowStartupPicker] = useState(false);
  const [expandedTrend, setExpandedTrend] = useState<null | { title: string; unit: string; yDomain?: [number, number] }>(null);
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

      {/* KPI row */}
      <div className="grid grid-cols-6 gap-2.5 mb-3">
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
          <div className="grid grid-cols-4 gap-2.5 mb-3">
            {gaugesToShow.map((g) => {
              // v2.4.6: click-to-expand on the CPU gauge opens the same
              // 7-day trend modal the panel below uses. RAM/Disk gauges
              // stay non-clickable until we wire per-metric trends —
              // RAM already flips to the pressure panel at >75%, and
              // disk trend is per-drive (needs a label filter on the
              // useTrend hook that we don't have yet).
              const isCpu = g.label?.toLowerCase().includes('cpu');
              const clickable = isCpu && !!cpuTrend;
              const onClick = clickable
                ? () => setExpandedTrend({ title: 'CPU Load - 7 Day Trend', unit: '%', yDomain: [0, 100] })
                : undefined;
              return (
                <div
                  key={g.label}
                  className={`bg-surface-800 border border-surface-600 rounded-lg p-3 ${clickable ? 'cursor-pointer hover:border-status-info/60 transition-colors' : ''}`}
                  onClick={onClick}
                  title={clickable ? 'Click to open 7-day trend' : undefined}
                >
                  <Gauge label={g.label} value={g.value} display={g.display} subtext={g.subtext} severity={g.severity} />
                </div>
              );
            })}
            {showPanel && (
              <RamPressurePanel status={status} onKillProcess={(name) => handleAction('kill_process', { target: name })} />
            )}
            {cpuTrend ? (
              <TrendLine
                title="CPU Load - 7 Day Trend"
                trend={cpuTrend}
                severity="info"
                yDomain={[0, 100]}
                onExpand={() => setExpandedTrend({ title: 'CPU Load - 7 Day Trend', unit: '%', yDomain: [0, 100] })}
              />
            ) : (
              <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering trend data…</div>
            )}
          </div>
        );
      })()}

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
          <div className="grid grid-cols-2 gap-2.5 mb-3">
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

      {/* Services + Actions + Alerts row */}
      <div className="grid grid-cols-3 gap-2.5 mb-3">
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">Services & Processes</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(status.services ?? []).slice(0, 9).map((s) => (
              <ServicePill key={s.key} service={s} onClick={setSelectedService} />
            ))}
          </div>
        </div>

        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2 flex items-center gap-1">
            <span>⚡</span><span>One-Click Actions</span>
          </div>
          <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))' }}>
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

      {/* SMART + Event log chart + Security stub */}
      <div className="grid grid-cols-3 gap-2.5">
        <SmartTable entries={status.smart ?? []} />
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
              <SecRow label="Windows Defender" tone={security.defender?.severity} right={security.defender?.realtime_protection ? `Active · Defs ${security.defender.defs_age_hours}h` : 'Disabled'} />
              <SecRow label="Windows Firewall" tone={security.firewall?.severity} right={security.firewall && security.firewall.domain_enabled && security.firewall.private_enabled && security.firewall.public_enabled ? 'All profiles enabled' : 'Partial'} />
              <SecRow label="Windows Update" tone={security.windows_update?.severity} right={security.windows_update ? `${security.windows_update.pending_count} pending${security.windows_update.pending_security_count > 0 ? ` (${security.windows_update.pending_security_count} security)` : ''}` : '-'} />
              <SecRow label={`Failed Logins (7d)`} tone={security.failed_logins?.severity} right={`${security.failed_logins?.total_7d ?? 0} events`} />
              <SecRow label="BitLocker" tone={security.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'} right={security.bitlocker.some(b => b.protection_on) ? `${security.bitlocker.filter(b => b.protection_on).length} protected` : 'Off - drives unencrypted'} />
              <SecRow label="UAC" tone={security.uac?.severity} right={security.uac?.enabled ? (security.uac.level === 'Disabled' ? 'Disabled' : 'Enabled') : 'DISABLED'} />
              <SecRow label="GPU Driver" tone={security.gpu_driver?.severity} right={security.gpu_driver ? `${security.gpu_driver.gpu_current_version}${security.gpu_driver.age_days !== null ? ` - ${security.gpu_driver.age_days}d old` : ''}` : '-'} />
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

      <div className="mt-3 grid grid-cols-2 gap-2.5">
        <AuthEventsWidget />
        <BsodPanel />
      </div>

      {selectedService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => setSelectedService(null)}>
          <div className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-md p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${selectedService.status_severity === 'good' ? 'bg-status-good' : selectedService.status_severity === 'warn' ? 'bg-status-warn' : 'bg-status-crit'}`}></span>
              <span>{selectedService.display}</span>
            </h2>
            <div className="text-sm text-text-secondary space-y-1 mb-4">
              <div>Status: <span className="text-text-primary font-mono">{selectedService.status}</span></div>
              {selectedService.start && <div>Start type: <span className="text-text-primary font-mono">{selectedService.start}</span></div>}
              <div>Service key: <span className="text-text-primary font-mono">{selectedService.key}</span></div>
              {selectedService.detail && <div className="text-[10px] mt-2">{selectedService.detail}</div>}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setSelectedService(null)} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
                Close
              </button>
              <button
                onClick={async () => {
                  const name = selectedService.key;
                  setSelectedService(null);
                  await run({ name: 'restart_service', params: { service_name: name } });
                  setToast(`Restart triggered for ${name}`);
                  setTimeout(() => setToast(null), 4000);
                }}
                disabled={running !== null}
                className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-semibold disabled:opacity-50"
              >
                Restart Service
              </button>
            </div>
          </div>
        </div>
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

      {expandedTrend && cpuTrend && (
        <TrendLineModal
          title={expandedTrend.title}
          trend={cpuTrend}
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
