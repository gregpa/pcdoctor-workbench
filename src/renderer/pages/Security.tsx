import { useSecurityPosture } from '@renderer/hooks/useSecurityPosture.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';

function Panel({ title, children, severity }: { title: string; children: React.ReactNode; severity?: string }) {
  const border = severity === 'crit' ? 'border-status-crit/40' : severity === 'warn' ? 'border-status-warn/40' : 'border-surface-600';
  return (
    <div className={`bg-surface-800 border ${border} rounded-lg p-4`}>
      <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold mb-3">{title}</div>
      {children}
    </div>
  );
}

function KV({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' | 'crit' }) {
  const toneClass = tone === 'crit' ? 'text-status-crit font-semibold' : tone === 'warn' ? 'text-status-warn' : tone === 'good' ? 'text-status-good' : 'text-text-primary';
  return (
    <div className="flex justify-between text-xs py-1 border-b border-surface-700 last:border-0">
      <span className="text-text-secondary">{label}</span>
      <span className={toneClass}>{value}</span>
    </div>
  );
}

export function Security() {
  const { data, loading, error, refresh, approve } = useSecurityPosture();
  const { run, running } = useAction();
  const [toast, setToast] = useState<string | null>(null);

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Scanning security posture…</span>
    </div>
  );
  if (error || !data) return <div className="p-6 text-status-warn">Error: {error ?? 'no data'}</div>;

  async function applyAction(name: ActionName) {
    await run({ name });
    setToast(`${ACTIONS[name].label} triggered`);
    setTimeout(() => setToast(null), 4000);
  }

  const sevIcon = data.overall_severity === 'crit' ? '🔴' : data.overall_severity === 'warn' ? '🟡' : '🟢';

  return (
    <div className="p-5 max-w-6xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">🛡 Security Posture</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {sevIcon} Overall: {data.overall_severity.toUpperCase()} · Generated {new Date(data.generated_at * 1000).toLocaleString()}
          </div>
        </div>
        <button onClick={refresh} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">
          Re-scan
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Defender */}
        <Panel title="Microsoft Defender" severity={data.defender?.severity}>
          {data.defender ? (
            <div>
              <KV label="Real-time Protection" value={data.defender.realtime_protection ? 'Active' : 'DISABLED'} tone={data.defender.realtime_protection ? 'good' : 'crit'} />
              <KV label="Antispyware Engine" value={data.defender.antispyware_enabled ? 'Enabled' : 'Disabled'} tone={data.defender.antispyware_enabled ? 'good' : 'warn'} />
              <KV label="Tamper Protection" value={data.defender.tamper_protection ? 'On' : 'Off'} tone={data.defender.tamper_protection ? 'good' : 'warn'} />
              <KV label="Cloud Protection" value={data.defender.cloud_protection ? 'On' : 'Off'} tone={data.defender.cloud_protection ? 'good' : 'warn'} />
              <KV label="Defs Version" value={`${data.defender.defs_version} · ${data.defender.defs_age_hours}h old`} tone={data.defender.defs_age_hours > 48 ? 'warn' : 'good'} />
              <KV label="Last Quick Scan" value={data.defender.last_quick_scan_hours ? `${data.defender.last_quick_scan_hours}h ago` : '—'} />
              <KV label="Last Full Scan" value={data.defender.last_full_scan_days ? `${data.defender.last_full_scan_days}d ago` : 'Never'} tone={data.defender.last_full_scan_days && data.defender.last_full_scan_days > 30 ? 'warn' : 'good'} />
              <div className="flex gap-2 mt-3">
                <button onClick={() => applyAction('update_defender_defs')} disabled={running !== null} className="px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] disabled:opacity-50">Update Defs</button>
                <button onClick={() => applyAction('defender_quick_scan')} disabled={running !== null} className="px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] disabled:opacity-50">Quick Scan</button>
                <button onClick={() => applyAction('defender_full_scan')} disabled={running !== null} className="px-2.5 py-1.5 rounded-md bg-status-warn text-black text-[11px] font-bold disabled:opacity-50">Full Scan</button>
              </div>
            </div>
          ) : <div className="text-xs text-text-secondary">Defender data unavailable</div>}
        </Panel>

        {/* Firewall */}
        <Panel title="Windows Firewall" severity={data.firewall?.severity}>
          {data.firewall ? (
            <div>
              <KV label="Domain Profile" value={data.firewall.domain_enabled ? 'Enabled' : 'Disabled'} tone={data.firewall.domain_enabled ? 'good' : 'crit'} />
              <KV label="Private Profile" value={data.firewall.private_enabled ? 'Enabled' : 'Disabled'} tone={data.firewall.private_enabled ? 'good' : 'crit'} />
              <KV label="Public Profile" value={data.firewall.public_enabled ? 'Enabled' : 'Disabled'} tone={data.firewall.public_enabled ? 'good' : 'crit'} />
              <KV label="Default Inbound" value={data.firewall.default_inbound_action} />
              <KV label="Total Rules" value={`${data.firewall.rules_total}`} />
              <div className="flex gap-2 mt-3">
                <button onClick={() => applyAction('reset_firewall')} disabled={running !== null} className="px-2.5 py-1.5 rounded-md bg-surface-700 border border-surface-600 text-[11px] disabled:opacity-50">Reset Firewall</button>
              </div>
            </div>
          ) : <div className="text-xs text-text-secondary">Firewall data unavailable</div>}
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        {/* Windows Update */}
        <Panel title="Windows Update" severity={data.windows_update?.severity}>
          {data.windows_update ? (
            <div>
              <KV label="Pending Updates" value={`${data.windows_update.pending_count}`} tone={data.windows_update.pending_count > 0 ? 'warn' : 'good'} />
              <KV label="Security Pending" value={`${data.windows_update.pending_security_count}`} tone={data.windows_update.pending_security_count > 0 ? 'warn' : 'good'} />
              <KV label="Last Success" value={data.windows_update.last_success_days !== null ? `${data.windows_update.last_success_days.toFixed(1)}d ago` : 'never'} tone={(data.windows_update.last_success_days ?? 0) > 30 ? 'warn' : 'good'} />
              <KV label="Reboot Pending" value={data.windows_update.reboot_pending ? 'Yes' : 'No'} tone={data.windows_update.reboot_pending ? 'warn' : 'good'} />
              <KV label="wuauserv" value={data.windows_update.wu_service_status} />
            </div>
          ) : <div className="text-xs text-text-secondary">WU data unavailable</div>}
        </Panel>

        {/* Failed Logins */}
        <Panel title="Authentication & Access" severity={data.failed_logins?.severity}>
          {data.failed_logins ? (
            <div>
              <KV label="Failed Logons (7d)" value={`${data.failed_logins.total_7d}`} tone={data.failed_logins.total_7d > 50 ? 'warn' : 'good'} />
              <KV label="Failed Logons (24h)" value={`${data.failed_logins.total_24h}`} />
              <KV label="Account Lockouts (7d)" value={`${data.failed_logins.lockouts_7d}`} tone={data.failed_logins.lockouts_7d > 0 ? 'warn' : 'good'} />
              <KV label="RDP Attempts (7d)" value={`${data.failed_logins.rdp_attempts_7d}`} />
              {data.failed_logins.top_sources.length > 0 && (
                <div className="mt-2 text-xs">
                  <div className="text-text-secondary mb-1">Top source IPs:</div>
                  {data.failed_logins.top_sources.map((s) => (
                    <div key={s.ip} className="flex justify-between">
                      <span className="font-mono">{s.ip}</span>
                      <span className="text-status-warn">{s.count}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : <div className="text-xs text-text-secondary">Event log unavailable</div>}
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        {/* BitLocker */}
        <Panel title="BitLocker" severity={data.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'}>
          {data.bitlocker.length > 0 ? data.bitlocker.map((v) => (
            <KV key={v.drive} label={v.drive} value={v.protection_on ? `Protected (${v.encryption_pct}%)` : v.status} tone={v.protection_on ? 'good' : 'warn'} />
          )) : <div className="text-xs text-text-secondary">No BitLocker data</div>}
        </Panel>

        {/* UAC */}
        <Panel title="UAC" severity={data.uac?.severity}>
          {data.uac ? (
            <>
              <KV label="Enabled" value={data.uac.enabled ? 'Yes' : 'DISABLED'} tone={data.uac.enabled ? 'good' : 'crit'} />
              <KV label="Level" value={data.uac.level} tone={data.uac.level === 'Disabled' ? 'crit' : 'good'} />
              {!data.uac.enabled && (
                <div className="mt-2 text-[11px] text-status-crit">
                  UAC is a critical defense. Enable via Control Panel → User Accounts → Change UAC settings.
                </div>
              )}
            </>
          ) : <div className="text-xs text-text-secondary">UAC data unavailable</div>}
        </Panel>

        {/* GPU Driver */}
        <Panel title="GPU Driver" severity={data.gpu_driver?.severity}>
          {data.gpu_driver ? (
            <>
              <KV label="Vendor" value={data.gpu_driver.gpu_vendor} />
              <KV label="Version" value={data.gpu_driver.gpu_current_version} />
              <KV label="Age" value={data.gpu_driver.age_days !== null ? `${data.gpu_driver.age_days} days` : '—'} tone={(data.gpu_driver.age_days ?? 0) > 180 ? 'warn' : 'good'} />
            </>
          ) : <div className="text-xs text-text-secondary">No GPU detected</div>}
        </Panel>
      </div>

      {/* Threat indicators */}
      {data.threat_indicators.length > 0 && (
        <Panel title={`Threat Indicators (${data.threat_indicators.length})`} severity="warn">
          <div className="space-y-2">
            {data.threat_indicators.map((t) => (
              <div key={t.id} className="text-xs p-2 rounded-md bg-status-warn/10 border border-status-warn/30">
                <div className="font-semibold flex items-center gap-2">
                  <span>{t.severity === 'critical' ? '🔴' : t.severity === 'high' ? '⚠' : 'ℹ'}</span>
                  <span>{t.category}</span>
                  <span className="text-text-secondary text-[10px]">{new Date(t.detected_at * 1000).toLocaleString()}</span>
                </div>
                <div className="mt-1 text-text-secondary">{t.message}</div>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* Persistence items */}
      <Panel title={`Persistence (${data.persistence_items.length} items)`}>
        {data.persistence_items.length === 0 ? (
          <div className="text-xs text-text-secondary">No persistence items requiring review.</div>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {data.persistence_items.slice(0, 50).map((p) => (
              <div key={p.identifier} className={`flex items-center gap-2 text-xs p-2 rounded-md ${p.is_new ? 'bg-status-warn/10 border border-status-warn/30' : 'bg-surface-900 border border-surface-700'}`}>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-surface-700 text-text-secondary uppercase">{p.kind}</span>
                {p.is_new && <span className="text-[9px] px-1.5 py-0.5 rounded bg-status-warn/30 text-status-warn font-semibold">NEW</span>}
                <div className="flex-1 min-w-0">
                  <div className="truncate font-semibold">{p.name}</div>
                  {p.path && <div className="text-[10px] text-text-secondary truncate">{p.path}</div>}
                </div>
                {p.approved !== 1 && (
                  <>
                    <button onClick={() => approve(p.identifier, true)} className="px-2 py-0.5 rounded bg-surface-700 border border-surface-600 text-[10px] hover:border-status-good/40">Approve</button>
                    <button onClick={() => approve(p.identifier, false)} className="px-2 py-0.5 rounded bg-surface-700 border border-surface-600 text-[10px] hover:border-status-crit/40">Reject</button>
                  </>
                )}
                {p.approved === 1 && <span className="text-[10px] text-status-good">✓ Approved</span>}
              </div>
            ))}
          </div>
        )}
      </Panel>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
