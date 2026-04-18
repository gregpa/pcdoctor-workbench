import { useState } from 'react';
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
import { TrendLine } from '@renderer/components/dashboard/TrendLine.js';
import { TrendBar } from '@renderer/components/dashboard/TrendBar.js';
import { SmartTable } from '@renderer/components/dashboard/SmartTable.js';
import { AuthEventsWidget } from '@renderer/components/dashboard/AuthEventsWidget.js';
import { ServicePill } from '@renderer/components/dashboard/ServicePill.js';
import { CleanMyPC } from '@renderer/components/dashboard/CleanMyPC.js';
import { ACTIONS } from '@shared/actions.js';
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
  const { status, error, loading } = useStatus();
  const { run, running } = useAction();
  const { trend: cpuTrend } = useTrend('cpu', 'load_pct', 7);
  const { trend: eventsTrend } = useTrend('events', 'system_count', 7);
  const { data: security } = useSecurityPosture();
  const { review: weeklyReview } = useWeeklyReview();
  const navigate = useNavigate();
  const [toast, setToast] = useState<string | null>(null);
  const [selectedService, setSelectedService] = useState<ServiceHealth | null>(null);

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
    await run({ name, params, dry_run: dryRun });
    setToast(`${ACTIONS[name].label}${dryRun ? ' (dry run)' : ''} completed`);
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
        onScan={() => {}}
        scanning={false}
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

      {/* Gauges + 7-day trend */}
      <div className="grid grid-cols-4 gap-2.5 mb-3">
        {status.gauges.slice(0, 3).map((g) => (
          <div key={g.label} className="bg-surface-800 border border-surface-600 rounded-lg p-3">
            <Gauge label={g.label} value={g.value} display={g.display} subtext={g.subtext} severity={g.severity} />
          </div>
        ))}
        {cpuTrend ? (
          <TrendLine title="CPU Load — 7 Day Trend" trend={cpuTrend} severity="info" yDomain={[0, 100]} />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering trend data…</div>
        )}
      </div>

      <div className="mb-3">
        <CleanMyPC status={status} />
      </div>

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
              <ActionButton key={name} action={ACTIONS[name]} onRun={(params, dryRun) => handleAction(name, params, dryRun)} disabled={running !== null} />
            ))}
          </div>
        </div>

        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">
            Active Alerts {status.findings.length > 0 ? `(${status.findings.length})` : ''}
          </div>
          <div className="space-y-2">
            {status.findings.length === 0 && <div className="text-xs text-text-secondary">No active findings. System healthy.</div>}
            {status.findings.map((f, i) => (<AlertCard key={i} finding={f} onApply={handleAction} />))}
          </div>
        </div>
      </div>

      {/* SMART + Event log chart + Security stub */}
      <div className="grid grid-cols-3 gap-2.5">
        <SmartTable entries={status.smart ?? []} />
        {eventsTrend ? (
          <TrendBar title="Event Log Errors — 7 Day" trend={eventsTrend} warnAt={300} critAt={500} />
        ) : (
          <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 flex items-center justify-center text-text-secondary text-xs">Gathering event trend…</div>
        )}
        <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
          <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">Security & Updates</div>
          {security ? (
            <div className="space-y-1.5 text-[11px]">
              <SecRow label="Windows Defender" tone={security.defender?.severity} right={security.defender?.realtime_protection ? `Active · Defs ${security.defender.defs_age_hours}h` : 'Disabled'} />
              <SecRow label="Windows Firewall" tone={security.firewall?.severity} right={security.firewall && security.firewall.domain_enabled && security.firewall.private_enabled && security.firewall.public_enabled ? 'All profiles enabled' : 'Partial'} />
              <SecRow label="Windows Update" tone={security.windows_update?.severity} right={security.windows_update ? `${security.windows_update.pending_count} pending${security.windows_update.pending_security_count > 0 ? ` (${security.windows_update.pending_security_count} security)` : ''}` : '—'} />
              <SecRow label={`Failed Logins (7d)`} tone={security.failed_logins?.severity} right={`${security.failed_logins?.total_7d ?? 0} events`} />
              <SecRow label="BitLocker" tone={security.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'} right={security.bitlocker.some(b => b.protection_on) ? `${security.bitlocker.filter(b => b.protection_on).length} protected` : 'Off — drives unencrypted'} />
              <SecRow label="UAC" tone={security.uac?.severity} right={security.uac?.enabled ? (security.uac.level === 'Disabled' ? 'Disabled' : 'Enabled') : 'DISABLED'} />
              <SecRow label="GPU Driver" tone={security.gpu_driver?.severity} right={security.gpu_driver ? `${security.gpu_driver.gpu_current_version}${security.gpu_driver.age_days !== null ? ` — ${security.gpu_driver.age_days}d old` : ''}` : '—'} />
              {security.persistence_new_count > 0 && (
                <div className="pt-2 mt-2 border-t border-surface-700 text-[10px] text-status-warn">
                  ⚠ {security.persistence_new_count} new persistence item{security.persistence_new_count === 1 ? '' : 's'} — review in Security page
                </div>
              )}
            </div>
          ) : (
            <div className="text-xs text-text-secondary">Loading security posture…</div>
          )}
        </div>
      </div>

      <div className="mt-3">
        <AuthEventsWidget />
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

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
