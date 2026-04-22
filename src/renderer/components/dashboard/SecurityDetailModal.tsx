/**
 * SecurityDetailModal (v2.4.26)
 *
 * Opened when the user clicks any row in the Security & Updates column.
 * One component handles all seven tile kinds (Defender, Firewall, Windows
 * Update, Failed Logins, BitLocker, UAC, GPU Driver) via a discriminated
 * `kind` prop.
 *
 * Each kind renders an appropriate attribute grid + severity explanation +
 * optional action buttons that route through the parent's action handler.
 * Actions that don't have a clean PS mapping (e.g. UAC level change,
 * GPU driver update) skip the button and point users at the manufacturer
 * or OS UI instead.
 *
 * E-13 fix (bug B14): Defender PUA / Network Protection fields are
 * tamper-aware. When Tamper Protection is ON and the raw value is empty
 * or 'Disabled' (which is the value Defender returns when it can't read
 * the setting, not when it's genuinely off), we show
 * "Not readable - Tamper Protection on" instead of a blank field.
 */
import type { SecurityPosture } from '@shared/types.js';

export type SecurityDetailKind =
  | 'defender'
  | 'firewall'
  | 'windows_update'
  | 'failed_logins'
  | 'bitlocker'
  | 'uac'
  | 'gpu_driver';

export interface SecurityDetailModalProps {
  kind: SecurityDetailKind;
  posture: SecurityPosture;
  onClose: () => void;

  /** Routes to `defender_quick_scan` action. */
  onDefenderQuickScan?: () => void | Promise<void>;
  /** Routes to `update_defender_defs` action. */
  onUpdateDefenderDefs?: () => void | Promise<void>;
  /** Opens Windows Security UI via `open_windows_security` action. */
  onOpenWindowsSecurity?: () => void | Promise<void>;
  /** Opens wf.msc via `open_firewall_console` action. */
  onOpenFirewallConsole?: () => void | Promise<void>;
  /** Navigates to the in-app Updates page. */
  onOpenUpdatesPage?: () => void;
  /** Routes to `unblock_ip` action with the ip param. */
  onUnblockIP?: (ip: string) => void | Promise<void>;
  /** Launches the locally-installed NVIDIA App / GeForce Experience /
   *  Control Panel. Only meaningful when the GPU vendor is NVIDIA. */
  onOpenNvidiaApp?: () => void | Promise<void>;
}

// E-13: Tamper-aware Defender field value.
// When Tamper Protection is ON, Defender refuses to reveal the real
// value of many sub-settings (PUA, CFA, Network Protection) and returns
// '', '0', or 'Disabled' regardless of actual state. v2.4.26 surfaces
// this distinction so the user knows the field isn't genuinely off.
function tamperAwareValue(raw: string | undefined, tamperOn: boolean): string {
  const empty = !raw || raw === '' || raw === 'Disabled' || raw === '0';
  if (tamperOn && empty) return 'Not readable (Tamper Protection on)';
  if (raw === '0' || raw === 'Disabled' || !raw) return 'Off';
  if (raw === '1' || raw === 'Enabled') return 'On';
  if (raw === '6' || raw === 'AuditMode') return 'Audit mode';
  return raw;
}

function sevBadgeClass(sev: 'good' | 'warn' | 'crit' | undefined): string {
  return sev === 'crit' ? 'bg-status-crit/20 text-status-crit border-status-crit/40'
       : sev === 'warn' ? 'bg-status-warn/20 text-status-warn border-status-warn/40'
       :                   'bg-status-good/20 text-status-good border-status-good/40';
}

function formatHours(h: number | null | undefined): string {
  if (h === null || h === undefined) return 'never';
  if (h < 1) return '<1 h ago';
  if (h < 48) return `${Math.round(h)} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

function formatDays(d: number | null | undefined): string {
  if (d === null || d === undefined) return 'never';
  if (d < 1) return 'today';
  return `${Math.round(d)} d ago`;
}

function modalTitleFor(kind: SecurityDetailKind): { icon: string; label: string } {
  switch (kind) {
    case 'defender':        return { icon: '🛡', label: 'Windows Defender' };
    case 'firewall':        return { icon: '🧱', label: 'Windows Firewall' };
    case 'windows_update':  return { icon: '🪟', label: 'Windows Update' };
    case 'failed_logins':   return { icon: '🔒', label: 'Failed Logins (7d)' };
    case 'bitlocker':       return { icon: '💾', label: 'BitLocker' };
    case 'uac':             return { icon: '🛂', label: 'User Account Control' };
    case 'gpu_driver':      return { icon: '🎮', label: 'GPU Driver' };
  }
}

export function SecurityDetailModal({
  kind,
  posture,
  onClose,
  onDefenderQuickScan,
  onUpdateDefenderDefs,
  onOpenWindowsSecurity,
  onOpenFirewallConsole,
  onOpenUpdatesPage,
  onUnblockIP,
  onOpenNvidiaApp,
}: SecurityDetailModalProps) {
  const title = modalTitleFor(kind);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${title.label} details`}
    >
      <div
        className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-2xl p-5 shadow-2xl max-h-[85vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
          <span>{title.icon}</span>
          <span>{title.label}</span>
        </h2>

        <div className="space-y-3">
          {kind === 'defender'        && <DefenderBody posture={posture} />}
          {kind === 'firewall'        && <FirewallBody posture={posture} />}
          {kind === 'windows_update'  && <WindowsUpdateBody posture={posture} />}
          {kind === 'failed_logins'   && <FailedLoginsBody posture={posture} onUnblockIP={onUnblockIP} />}
          {kind === 'bitlocker'       && <BitLockerBody posture={posture} />}
          {kind === 'uac'             && <UacBody posture={posture} />}
          {kind === 'gpu_driver'      && <GpuDriverBody posture={posture} />}
        </div>

        <div className="flex justify-end items-center gap-2 pt-4 mt-3 border-t border-surface-700 flex-wrap">
          {kind === 'defender' && (
            <>
              {onDefenderQuickScan && (
                <button
                  onClick={() => void onDefenderQuickScan()}
                  className="px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/50 text-status-info hover:bg-status-info/30"
                >
                  Quick Scan
                </button>
              )}
              {onUpdateDefenderDefs && (
                <button
                  onClick={() => void onUpdateDefenderDefs()}
                  className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 text-text-primary hover:border-surface-500"
                >
                  Update Defs
                </button>
              )}
              {onOpenWindowsSecurity && (
                <button
                  onClick={() => void onOpenWindowsSecurity()}
                  className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 text-text-primary hover:border-surface-500"
                >
                  Open Windows Security
                </button>
              )}
            </>
          )}
          {kind === 'firewall' && onOpenFirewallConsole && (
            <button
              onClick={() => void onOpenFirewallConsole()}
              className="px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/50 text-status-info hover:bg-status-info/30"
            >
              Open Firewall Console
            </button>
          )}
          {kind === 'windows_update' && onOpenUpdatesPage && (
            <button
              onClick={onOpenUpdatesPage}
              className="px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/50 text-status-info hover:bg-status-info/30"
            >
              Open Updates page
            </button>
          )}
          {kind === 'gpu_driver' && onOpenNvidiaApp && posture.gpu_driver?.gpu_vendor?.toUpperCase().includes('NVIDIA') && (
            <button
              onClick={() => void onOpenNvidiaApp()}
              className="px-3 py-1.5 rounded-md text-xs bg-status-info/20 border border-status-info/50 text-status-info hover:bg-status-info/30"
              title="Launches the NVIDIA App / GeForce Experience where drivers are managed. Falls back to the web page only if no local tool is detected."
            >
              Open NVIDIA App
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ============ per-kind body components ============

function FieldGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
      {children}
    </div>
  );
}

function Field({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <>
      <span className="text-text-secondary">{label}</span>
      <span>
        <span className="text-text-primary">{value}</span>
        {note && <span className="ml-2 text-text-secondary italic">{note}</span>}
      </span>
    </>
  );
}

function SeverityNote({ sev, children }: { sev: 'good' | 'warn' | 'crit' | undefined; children: React.ReactNode }) {
  return (
    <div className="text-[11px] text-text-secondary leading-relaxed p-2.5 rounded bg-surface-900/50 border border-surface-700 flex items-center gap-2">
      <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded border ${sevBadgeClass(sev)}`}>
        {sev ?? 'unknown'}
      </span>
      <span>{children}</span>
    </div>
  );
}

function DefenderBody({ posture }: { posture: SecurityPosture }) {
  const d = posture.defender;
  if (!d) return <div className="text-[11px] text-text-secondary">No Defender data. Is Defender installed / running?</div>;
  const tamperOn = !!d.tamper_protection;
  return (
    <>
      <SeverityNote sev={d.realtime_protection ? 'good' : 'crit'}>
        {d.realtime_protection
          ? `Real-time protection is ON. Definitions are ${d.defs_age_hours}h old.`
          : 'Real-time protection is OFF. Malware can run undetected. Re-enable ASAP.'}
      </SeverityNote>
      <FieldGrid>
        <Field label="Real-time protection" value={d.realtime_protection ? 'On' : 'Off'} />
        <Field label="Antispyware" value={d.antispyware_enabled ? 'On' : 'Off'} />
        <Field label="Tamper Protection" value={tamperOn ? 'On' : 'Off'} note={tamperOn ? 'Locks settings from modification' : 'Some policies can be disabled by malware'} />
        <Field label="Cloud Protection" value={d.cloud_protection ? 'On' : 'Off'} />
        <Field label="PUA Protection" value={tamperAwareValue(d.puaprotection, tamperOn)} />
        <Field label="Controlled Folder Access" value={tamperAwareValue(d.controlled_folder_access, tamperOn)} />
        <Field label="Network Protection" value={tamperAwareValue(d.network_protection, tamperOn)} />
        <Field label="Definitions" value={`${d.defs_version ?? '(unknown)'}`} note={`${d.defs_age_hours}h old`} />
        <Field label="Engine" value={d.engine_version ?? '(unknown)'} />
        <Field label="Last quick scan" value={formatHours(d.last_quick_scan_hours)} />
        <Field label="Last full scan" value={formatDays(d.last_full_scan_days)} />
        <Field label="Threats quarantined (7d)" value={`${d.threats_quarantined_7d}`} />
        <Field label="Active threats" value={`${d.threats_active}`} note={d.threats_active > 0 ? 'ACTION REQUIRED - open Windows Security' : ''} />
        <Field label="Exclusions" value={`${d.exclusions_count} path(s)`} />
      </FieldGrid>
    </>
  );
}

function FirewallBody({ posture }: { posture: SecurityPosture }) {
  const f = posture.firewall;
  if (!f) return <div className="text-[11px] text-text-secondary">No Firewall data.</div>;
  const allOn = f.domain_enabled && f.private_enabled && f.public_enabled;
  return (
    <>
      <SeverityNote sev={allOn ? 'good' : 'warn'}>
        {allOn
          ? 'All three firewall profiles (Domain / Private / Public) are enabled.'
          : 'At least one profile is disabled. The affected network type has no firewall protection.'}
      </SeverityNote>
      <FieldGrid>
        <Field label="Domain profile"  value={f.domain_enabled  ? 'Enabled' : 'Disabled'} />
        <Field label="Private profile" value={f.private_enabled ? 'Enabled' : 'Disabled'} />
        <Field label="Public profile"  value={f.public_enabled  ? 'Enabled' : 'Disabled'} />
        <Field label="Default inbound action" value={f.default_inbound_action} note={f.default_inbound_action === 'Allow' ? 'UNUSUAL - inbound traffic is allowed by default' : ''} />
        <Field label="Total rules" value={`${f.rules_total}`} />
        <Field label="Rules added (7d)" value={`${f.rules_added_7d}`} note={f.rules_added_7d > 10 ? 'High churn - unusual installer activity?' : ''} />
      </FieldGrid>
    </>
  );
}

function WindowsUpdateBody({ posture }: { posture: SecurityPosture }) {
  const w = posture.windows_update;
  if (!w) return <div className="text-[11px] text-text-secondary">No Windows Update data.</div>;
  return (
    <>
      <SeverityNote sev={w.severity}>
        {w.pending_security_count > 0
          ? `${w.pending_security_count} security update(s) pending. Install from the Updates page.`
          : w.pending_count > 0
            ? `${w.pending_count} non-security update(s) pending.`
            : 'No pending updates - you are current.'}
      </SeverityNote>
      <FieldGrid>
        <Field label="Pending updates" value={`${w.pending_count}`} />
        <Field label="Pending security" value={`${w.pending_security_count}`} note={w.pending_security_count > 0 ? 'Prioritize these' : ''} />
        <Field label="Last successful install" value={formatDays(w.last_success_days)} />
        <Field label="Reboot pending" value={w.reboot_pending ? 'YES' : 'No'} note={w.reboot_pending ? 'Reboot to finish applying updates' : ''} />
        <Field label="WU service" value={w.wu_service_status} />
      </FieldGrid>
    </>
  );
}

function FailedLoginsBody({ posture, onUnblockIP }: { posture: SecurityPosture; onUnblockIP?: (ip: string) => void | Promise<void> }) {
  const fl = posture.failed_logins;
  if (!fl) return <div className="text-[11px] text-text-secondary">No auth-event data.</div>;
  return (
    <>
      <SeverityNote sev={fl.severity}>
        {fl.rdp_attempts_7d > 0
          ? `${fl.rdp_attempts_7d} RDP brute-force attempt(s) in the last 7 days. Consider blocking the source IPs.`
          : fl.total_7d > 0
            ? `${fl.total_7d} failed login attempt(s) in 7 days. Likely local typos unless top sources show remote IPs.`
            : 'No failed logins in the last 7 days.'}
      </SeverityNote>
      <FieldGrid>
        <Field label="Failed (24h)" value={`${fl.total_24h}`} />
        <Field label="Failed (7d)" value={`${fl.total_7d}`} />
        <Field label="Account lockouts (7d)" value={`${fl.lockouts_7d}`} />
        <Field label="RDP attempts (7d)" value={`${fl.rdp_attempts_7d}`} note={fl.rdp_attempts_7d > 0 ? 'Remote attacker signal' : ''} />
      </FieldGrid>
      {fl.top_sources.length > 0 && (
        <div className="mt-2">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">Top source IPs</div>
          <table className="w-full text-[11px]">
            <thead className="text-text-secondary text-[9px] uppercase tracking-wider">
              <tr>
                <th className="text-left font-normal pb-1">IP</th>
                <th className="text-left font-normal pb-1">Count</th>
                <th className="text-left font-normal pb-1">Geo</th>
                <th className="text-right font-normal pb-1"></th>
              </tr>
            </thead>
            <tbody>
              {fl.top_sources.slice(0, 10).map((s) => (
                <tr key={s.ip} className="border-t border-surface-700">
                  <td className="py-1 font-mono">{s.ip}</td>
                  <td className="py-1">{s.count}</td>
                  <td className="py-1 text-text-secondary truncate max-w-[200px]">
                    {[s.city, s.country, s.isp].filter(Boolean).join(', ') || '-'}
                  </td>
                  <td className="py-1 text-right">
                    {onUnblockIP && (
                      <button
                        onClick={() => void onUnblockIP(s.ip)}
                        className="text-[10px] text-status-info hover:underline"
                        title={`Remove any existing PCDoctor block rule for ${s.ip}`}
                      >
                        Unblock
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function BitLockerBody({ posture }: { posture: SecurityPosture }) {
  const vols = posture.bitlocker ?? [];
  const anyOn = vols.some(v => v.protection_on);
  return (
    <>
      <SeverityNote sev={anyOn ? 'good' : 'warn'}>
        {vols.length === 0
          ? 'No BitLocker-capable volumes detected.'
          : anyOn
            ? `${vols.filter(v => v.protection_on).length} of ${vols.length} volume(s) protected.`
            : 'BitLocker is OFF on all volumes. Physical-theft data access is unrestricted.'}
      </SeverityNote>
      {vols.length > 0 && (
        <table className="w-full text-[11px]">
          <thead className="text-text-secondary text-[9px] uppercase tracking-wider">
            <tr>
              <th className="text-left font-normal pb-1">Drive</th>
              <th className="text-left font-normal pb-1">Status</th>
              <th className="text-left font-normal pb-1">Protection</th>
              <th className="text-right font-normal pb-1">Encrypted</th>
            </tr>
          </thead>
          <tbody>
            {vols.map((v) => (
              <tr key={v.drive} className="border-t border-surface-700">
                <td className="py-1 font-mono">{v.drive}</td>
                <td className="py-1">{v.status}</td>
                <td className="py-1">{v.protection_on ? 'On' : 'Off'}</td>
                <td className="py-1 text-right font-mono">{v.encryption_pct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function UacBody({ posture }: { posture: SecurityPosture }) {
  const u = posture.uac;
  if (!u) return <div className="text-[11px] text-text-secondary">No UAC data.</div>;
  const levelExplain: Record<string, string> = {
    AlwaysNotify:  'Strictest - prompts on every admin elevation AND settings change.',
    Default:       'Default - prompts on elevation, silent on Windows own settings.',
    NotifyChanges: 'Standard - matches Windows default, prompts only on admin elevation.',
    Disabled:      'DANGEROUS - admin programs run silently. All elevation prompts bypassed.',
    Unknown:       'Level not determinable from registry.',
  };
  return (
    <>
      <SeverityNote sev={u.severity}>
        {u.enabled
          ? 'UAC is enabled - admin tasks require confirmation.'
          : 'UAC is DISABLED. Any program can silently get admin privileges. Re-enable via Control Panel > Security > User Account Control.'}
      </SeverityNote>
      <FieldGrid>
        <Field label="EnableLUA" value={u.enabled ? 'On (1)' : 'Off (0)'} />
        <Field label="Slider level" value={u.level} note={levelExplain[u.level] ?? ''} />
      </FieldGrid>
    </>
  );
}

function GpuDriverBody({ posture }: { posture: SecurityPosture }) {
  const g = posture.gpu_driver;
  if (!g) return <div className="text-[11px] text-text-secondary">No GPU data.</div>;
  const updateUrls: Record<string, string> = {
    NVIDIA: 'https://www.nvidia.com/Download/index.aspx',
    AMD:    'https://www.amd.com/en/support',
    Intel:  'https://www.intel.com/content/www/us/en/download-center/home.html',
  };
  const vendorKey = Object.keys(updateUrls).find(k => g.gpu_vendor?.toUpperCase().includes(k.toUpperCase()));
  return (
    <>
      <SeverityNote sev={g.severity}>
        {g.age_days === null
          ? 'Could not determine driver age.'
          : g.age_days <= 90
            ? `Driver is ${g.age_days}d old - current.`
            : g.age_days <= 365
              ? `Driver is ${g.age_days}d old - consider updating.`
              : `Driver is ${g.age_days}d old - well out of date. Likely missing performance + security fixes.`}
      </SeverityNote>
      <FieldGrid>
        <Field label="Vendor" value={g.gpu_vendor ?? '(unknown)'} />
        <Field label="Version" value={g.gpu_current_version ?? '(unknown)'} />
        <Field label="Age" value={g.age_days === null ? 'unknown' : `${g.age_days} days`} />
        {vendorKey && vendorKey !== 'NVIDIA' && (
          // v2.4.27: AMD + Intel still link to the web. NVIDIA gets
          // the "Open NVIDIA App" footer button instead because Greg
          // installs drivers through the local app, not the web page.
          <Field
            label="Update"
            value={
              <a
                href={updateUrls[vendorKey]}
                target="_blank"
                rel="noreferrer noopener"
                className="text-status-info hover:underline"
              >
                {vendorKey} driver downloads
              </a>
            }
          />
        )}
      </FieldGrid>
    </>
  );
}
