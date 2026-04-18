import { useSecurityPosture } from '@renderer/hooks/useSecurityPosture.js';
import { useAction } from '@renderer/hooks/useAction.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { useState } from 'react';
import { LoadingSpinner } from '@renderer/components/layout/LoadingSpinner.js';
import { SecurityDetailModal } from '@renderer/components/security/SecurityDetailModal.js';
import { useNavigate } from 'react-router-dom';

type DetailKind = 'defender' | 'firewall' | 'wu' | 'auth' | 'bitlocker' | 'uac' | 'gpu' | null;

function Panel({ title, children, severity, onClick }: { title: string; children: React.ReactNode; severity?: string; onClick?: () => void }) {
  const border = severity === 'crit' ? 'border-status-crit/40' : severity === 'warn' ? 'border-status-warn/40' : 'border-surface-600';
  const clickable = !!onClick;
  return (
    <div
      onClick={onClick}
      className={`bg-surface-800 border ${border} rounded-lg p-4 ${clickable ? 'hover:border-status-info/40 cursor-pointer transition' : ''}`}
    >
      <div className="flex justify-between items-center mb-3">
        <div className="text-[10px] uppercase tracking-wider text-text-secondary font-semibold">{title}</div>
        {clickable && <span className="text-[10px] text-text-secondary">Click for details →</span>}
      </div>
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
  const { run } = useAction();
  const [toast, setToast] = useState<string | null>(null);
  const [detail, setDetail] = useState<DetailKind>(null);
  const navigate = useNavigate();

  if (loading) return (
    <div className="p-6 flex items-center gap-3 text-text-secondary">
      <LoadingSpinner size={18} /><span>Scanning security posture…</span>
    </div>
  );
  if (error || !data) return <div className="p-6 text-status-warn">Error: {error ?? 'no data'}</div>;

  async function applyAction(name: ActionName) {
    setToast(`Running ${ACTIONS[name].label}…`);
    await run({ name });
    setToast(`${ACTIONS[name].label} completed`);
    setTimeout(() => setToast(null), 4000);
    await refresh();
  }

  const sevIcon = data.overall_severity === 'crit' ? '🔴' : data.overall_severity === 'warn' ? '🟡' : '🟢';

  return (
    <div className="p-5 max-w-6xl">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-lg font-bold">🛡 Security Posture</h1>
          <div className="text-[11px] text-text-secondary mt-1">
            {sevIcon} Overall: {data.overall_severity.toUpperCase()} · Generated {new Date(data.generated_at * 1000).toLocaleString()} · <span className="text-text-secondary/80">Click any panel for details + fixes</span>
          </div>
        </div>
        <button onClick={refresh} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">Re-scan</button>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <Panel title="Microsoft Defender" severity={data.defender?.severity} onClick={() => setDetail('defender')}>
          {data.defender ? (
            <div>
              <KV label="Real-time Protection" value={data.defender.realtime_protection ? 'Active' : 'DISABLED'} tone={data.defender.realtime_protection ? 'good' : 'crit'} />
              <KV label="Defs Version" value={`${data.defender.defs_age_hours}h old`} tone={data.defender.defs_age_hours > 48 ? 'warn' : 'good'} />
              <KV label="Last Full Scan" value={data.defender.last_full_scan_days ? `${data.defender.last_full_scan_days}d ago` : 'Never'} tone={data.defender.last_full_scan_days && data.defender.last_full_scan_days > 30 ? 'warn' : 'good'} />
            </div>
          ) : <div className="text-xs text-text-secondary">Defender data unavailable</div>}
        </Panel>

        <Panel title="Windows Firewall" severity={data.firewall?.severity} onClick={() => setDetail('firewall')}>
          {data.firewall ? (
            <div>
              <KV label="Domain / Private / Public" value={[data.firewall.domain_enabled, data.firewall.private_enabled, data.firewall.public_enabled].map(b => b ? 'on' : 'OFF').join(' / ')} tone={data.firewall.domain_enabled && data.firewall.private_enabled && data.firewall.public_enabled ? 'good' : 'crit'} />
              <KV label="Total Rules" value={`${data.firewall.rules_total}`} />
            </div>
          ) : <div className="text-xs text-text-secondary">Firewall data unavailable</div>}
        </Panel>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-3">
        <Panel title="Windows Update" severity={data.windows_update?.severity} onClick={() => setDetail('wu')}>
          {data.windows_update ? (
            <div>
              <KV label="Pending" value={`${data.windows_update.pending_count} (${data.windows_update.pending_security_count} security)`} tone={data.windows_update.pending_count > 0 ? 'warn' : 'good'} />
              <KV label="Reboot Pending" value={data.windows_update.reboot_pending ? 'Yes' : 'No'} tone={data.windows_update.reboot_pending ? 'warn' : 'good'} />
            </div>
          ) : <div className="text-xs text-text-secondary">WU data unavailable</div>}
        </Panel>

        <Panel title="Authentication & Access" severity={data.failed_logins?.severity} onClick={() => setDetail('auth')}>
          {data.failed_logins ? (
            <div>
              <KV label="Failed Logons (7d)" value={`${data.failed_logins.total_7d}`} tone={data.failed_logins.total_7d > 50 ? 'warn' : 'good'} />
              <KV label="RDP Attempts (7d)" value={`${data.failed_logins.rdp_attempts_7d}`} />
            </div>
          ) : <div className="text-xs text-text-secondary">Event log unavailable</div>}
        </Panel>
      </div>

      <div className="grid grid-cols-3 gap-3 mb-3">
        <Panel title="BitLocker" severity={data.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'} onClick={() => setDetail('bitlocker')}>
          {data.bitlocker.length > 0 ? data.bitlocker.slice(0, 3).map(v => (
            <KV key={v.drive} label={v.drive} value={v.protection_on ? `${v.encryption_pct}%` : v.status} tone={v.protection_on ? 'good' : 'warn'} />
          )) : <div className="text-xs text-text-secondary">No BitLocker data</div>}
        </Panel>

        <Panel title="UAC" severity={data.uac?.severity} onClick={() => setDetail('uac')}>
          {data.uac ? (
            <>
              <KV label="Enabled" value={data.uac.enabled ? 'Yes' : 'DISABLED'} tone={data.uac.enabled ? 'good' : 'crit'} />
              <KV label="Level" value={data.uac.level} tone={data.uac.level === 'Disabled' ? 'crit' : 'good'} />
            </>
          ) : <div className="text-xs text-text-secondary">UAC data unavailable</div>}
        </Panel>

        <Panel title="GPU Driver" severity={data.gpu_driver?.severity} onClick={() => setDetail('gpu')}>
          {data.gpu_driver ? (
            <>
              <KV label="Version" value={data.gpu_driver.gpu_current_version} />
              <KV label="Age" value={data.gpu_driver.age_days !== null ? `${data.gpu_driver.age_days} days` : '—'} tone={(data.gpu_driver.age_days ?? 0) > 180 ? 'warn' : 'good'} />
            </>
          ) : <div className="text-xs text-text-secondary">No GPU detected</div>}
        </Panel>
      </div>

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

      <div className="mt-3">
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
                  <button
                    onClick={async () => {
                      const ctx = `Investigate this persistence item:\n- Kind: ${p.kind}\n- Name: ${p.name}\n- Path: ${p.path ?? 'unknown'}\n- Publisher: ${p.publisher ?? 'unknown'}\n- First seen: ${new Date(p.first_seen).toLocaleString()}\n- Signed: ${p.signed ?? 'unknown'}\n\nIs this legitimate? Should it be removed?`;
                      await (window as any).api.investigateWithClaude(ctx);
                    }}
                    className="px-2 py-0.5 rounded bg-surface-700 border border-surface-600 text-[10px] hover:border-status-info/40"
                    title="Investigate in Claude"
                  >
                    🤖
                  </button>
                  {p.approved === 1 && <span className="text-[10px] text-status-good">✓ Approved</span>}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ============== DETAIL MODALS ============== */}

      {detail === 'defender' && data.defender && (
        <SecurityDetailModal
          title="Microsoft Defender" icon="🛡" severity={data.defender.severity}
          onClose={() => setDetail(null)}
          actions={
            <>
              <button onClick={() => { setDetail(null); applyAction('update_defender_defs'); }} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Update Defs</button>
              <button onClick={() => { setDetail(null); applyAction('defender_quick_scan'); }} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Quick Scan</button>
              <button onClick={() => { setDetail(null); applyAction('defender_full_scan'); }} className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-bold">Full Scan</button>
            </>
          }
        >
          <div className="space-y-1">
            <div>Real-time Protection: <strong className={data.defender.realtime_protection ? 'text-status-good' : 'text-status-crit'}>{data.defender.realtime_protection ? 'Active' : 'DISABLED'}</strong></div>
            <div>Antispyware Engine: <strong>{data.defender.antispyware_enabled ? 'Enabled' : 'Disabled'}</strong></div>
            <div>Tamper Protection: <strong>{data.defender.tamper_protection ? 'On' : 'Off'}</strong></div>
            <div>Cloud Protection: <strong>{data.defender.cloud_protection ? 'On' : 'Off'}</strong></div>
            <div>PUA Protection: <strong>{data.defender.puaprotection}</strong></div>
            <div>Controlled Folder Access: <strong>{data.defender.controlled_folder_access}</strong></div>
            <div>Network Protection: <strong>{data.defender.network_protection}</strong></div>
            <div>Defs Version: <code className="text-text-primary">{data.defender.defs_version}</code> · {data.defender.defs_age_hours}h old</div>
            <div>Engine Version: <code className="text-text-primary">{data.defender.engine_version}</code></div>
            <div>Last Quick Scan: {data.defender.last_quick_scan_hours !== null ? `${data.defender.last_quick_scan_hours}h ago` : 'Never'}</div>
            <div>Last Full Scan: {data.defender.last_full_scan_days !== null ? `${data.defender.last_full_scan_days} days ago` : 'Never'}</div>
            {data.defender.last_full_scan_days !== null && data.defender.last_full_scan_days > 30 && (
              <div className="mt-2 text-status-warn text-xs">⚠ Full scan is overdue. Recommended monthly. Click "Full Scan" below (takes 1–4 hrs).</div>
            )}
          </div>
        </SecurityDetailModal>
      )}

      {detail === 'firewall' && data.firewall && (
        <SecurityDetailModal
          title="Windows Firewall" icon="🔥" severity={data.firewall.severity}
          onClose={() => setDetail(null)}
          actions={
            <button onClick={() => { setDetail(null); applyAction('reset_firewall'); }} className="px-3 py-1.5 rounded-md text-xs bg-status-crit text-white font-bold">Reset Firewall</button>
          }
        >
          <div className="space-y-1">
            <div>Domain Profile: <strong className={data.firewall.domain_enabled ? 'text-status-good' : 'text-status-crit'}>{data.firewall.domain_enabled ? 'Enabled' : 'Disabled'}</strong></div>
            <div>Private Profile: <strong className={data.firewall.private_enabled ? 'text-status-good' : 'text-status-crit'}>{data.firewall.private_enabled ? 'Enabled' : 'Disabled'}</strong></div>
            <div>Public Profile: <strong className={data.firewall.public_enabled ? 'text-status-good' : 'text-status-crit'}>{data.firewall.public_enabled ? 'Enabled' : 'Disabled'}</strong></div>
            <div>Default Inbound Action: <strong>{data.firewall.default_inbound_action}</strong></div>
            <div>Total Rules: <strong>{data.firewall.rules_total}</strong></div>
            {data.firewall.rules_added_7d > 0 && <div>Rules Added Last 7 Days: <strong>{data.firewall.rules_added_7d}</strong></div>}
          </div>
          <div className="mt-3 text-xs text-text-secondary">
            Reset Firewall removes ALL custom rules and restores Windows defaults. Apps may need to re-request network access on first launch afterward.
          </div>
        </SecurityDetailModal>
      )}

      {detail === 'wu' && data.windows_update && (
        <SecurityDetailModal
          title="Windows Update" icon="🪟" severity={data.windows_update.severity}
          onClose={() => setDetail(null)}
          actions={
            <button onClick={() => { setDetail(null); navigate('/updates'); }} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-bold">Open Updates Page</button>
          }
        >
          <div className="space-y-1">
            <div>Pending Updates: <strong>{data.windows_update.pending_count}</strong></div>
            <div>Security Pending: <strong className={data.windows_update.pending_security_count > 0 ? 'text-status-warn' : 'text-status-good'}>{data.windows_update.pending_security_count}</strong></div>
            <div>Last Success: {data.windows_update.last_success_days !== null ? `${data.windows_update.last_success_days.toFixed(1)}d ago` : 'Never'}</div>
            <div>Reboot Pending: <strong>{data.windows_update.reboot_pending ? 'Yes' : 'No'}</strong></div>
            <div>wuauserv: <code>{data.windows_update.wu_service_status}</code></div>
          </div>
          <div className="mt-3 text-xs text-text-secondary">
            Full update management (per-KB list, install + repair) lives on the Updates page.
          </div>
        </SecurityDetailModal>
      )}

      {detail === 'auth' && data.failed_logins && (
        <SecurityDetailModal
          title="Authentication & Access" icon="🔐" severity={data.failed_logins.severity}
          onClose={() => setDetail(null)}
        >
          <div className="space-y-1">
            <div>Failed Logons (7d): <strong className={data.failed_logins.total_7d > 50 ? 'text-status-warn' : 'text-status-good'}>{data.failed_logins.total_7d}</strong></div>
            <div>Failed Logons (24h): <strong>{data.failed_logins.total_24h}</strong></div>
            <div>Account Lockouts (7d): <strong>{data.failed_logins.lockouts_7d}</strong></div>
            <div>RDP Attempts (7d): <strong>{data.failed_logins.rdp_attempts_7d}</strong></div>
            {data.failed_logins.top_sources.length > 0 && (
              <div className="mt-2">
                <div className="text-text-secondary mb-1">Top source IPs:</div>
                {data.failed_logins.top_sources.map(s => (
                  <div key={s.ip} className="flex justify-between items-center text-xs gap-2">
                    <code>{s.ip}</code>
                    <span className="text-status-warn flex-1 text-right">{s.count} attempts</span>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        const ok = confirm(`Block ${s.ip} (inbound + outbound firewall rule)?`);
                        if (!ok) return;
                        setDetail(null);
                        await run({ name: 'block_ip', params: { ip: s.ip } });
                        setToast(`Blocked ${s.ip}`);
                        setTimeout(() => setToast(null), 4000);
                        await refresh();
                      }}
                      className="px-2 py-0.5 rounded bg-status-crit/20 border border-status-crit/40 text-[10px] hover:bg-status-crit/30"
                    >
                      Block
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="mt-3 text-xs text-text-secondary">
            Failed logon activity is pulled from Security Event Log (events 4625/4740). Sustained activity from a single IP is a brute-force signal.
          </div>
        </SecurityDetailModal>
      )}

      {detail === 'bitlocker' && (
        <SecurityDetailModal
          title="BitLocker" icon="🔒" severity={data.bitlocker.some(b => b.protection_on) ? 'good' : 'warn'}
          onClose={() => setDetail(null)}
        >
          {data.bitlocker.length === 0 ? (
            <div>No BitLocker-capable volumes detected.</div>
          ) : (
            <div className="space-y-2">
              {data.bitlocker.map(v => (
                <div key={v.drive} className="bg-surface-900 border border-surface-700 rounded-md p-3">
                  <div className="font-semibold">Drive {v.drive}</div>
                  <div>Status: <strong className={v.protection_on ? 'text-status-good' : 'text-status-warn'}>{v.status}</strong></div>
                  <div>Protection: <strong>{v.protection_on ? 'On' : 'Off'}</strong></div>
                  <div>Encryption: {v.encryption_pct}%</div>
                </div>
              ))}
              <div className="text-xs text-text-secondary pt-2">
                To enable BitLocker: Open <strong>Control Panel → BitLocker Drive Encryption</strong>, or run <code>manage-bde -on C:</code> from an admin PowerShell. Encryption takes hours depending on drive size.
              </div>
            </div>
          )}
        </SecurityDetailModal>
      )}

      {detail === 'uac' && data.uac && (
        <SecurityDetailModal
          title="User Account Control" icon="👤" severity={data.uac.severity}
          onClose={() => setDetail(null)}
        >
          <div className="space-y-1">
            <div>Enabled: <strong className={data.uac.enabled ? 'text-status-good' : 'text-status-crit'}>{data.uac.enabled ? 'Yes' : 'DISABLED'}</strong></div>
            <div>Prompt Level: <strong className={data.uac.level === 'Disabled' ? 'text-status-crit' : 'text-status-good'}>{data.uac.level}</strong></div>
          </div>
          {!data.uac.enabled && (
            <div className="mt-3 p-3 bg-status-crit/10 border border-status-crit/40 rounded-md text-xs">
              <strong>UAC is a critical defense layer.</strong> With it disabled, any malware that manages to run with your user token operates with full administrator privilege — no consent prompts, no elevation barrier. This is among the highest-impact single-line security improvements you can make.
              <div className="mt-2">
                <strong>To re-enable:</strong>
                <ol className="list-decimal pl-5 mt-1 space-y-0.5">
                  <li>Press Win+R, type <code>UserAccountControlSettings</code>, press Enter</li>
                  <li>Drag the slider up to "Notify me only when apps try to make changes (default)"</li>
                  <li>Click OK and restart to activate</li>
                </ol>
              </div>
            </div>
          )}
        </SecurityDetailModal>
      )}

      {detail === 'gpu' && (
        <SecurityDetailModal
          title="GPU Driver" icon="🎮" severity={data.gpu_driver?.severity}
          onClose={() => setDetail(null)}
        >
          {data.gpu_driver ? (
            <>
              <div className="space-y-1">
                <div>Vendor: <strong>{data.gpu_driver.gpu_vendor}</strong></div>
                <div>Current Version: <code>{data.gpu_driver.gpu_current_version}</code></div>
                <div>Driver Age: <strong className={(data.gpu_driver.age_days ?? 0) > 180 ? 'text-status-warn' : 'text-status-good'}>{data.gpu_driver.age_days} days</strong></div>
              </div>
              {data.gpu_driver.age_days !== null && data.gpu_driver.age_days > 180 && (
                <div className="mt-3 p-3 bg-status-warn/10 border border-status-warn/40 rounded-md text-xs">
                  Your GPU driver is over 6 months old. Update via:
                  <ul className="list-disc pl-5 mt-1">
                    <li><strong>NVIDIA App</strong> (recommended) — launches Games + Driver updater</li>
                    <li><strong>GeForce Experience</strong> — older UI, same driver source</li>
                    <li><strong>nvidia.com/drivers</strong> — manual download for cleanest install</li>
                  </ul>
                </div>
              )}
            </>
          ) : <div>No GPU detected on this system.</div>}
        </SecurityDetailModal>
      )}

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
