import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { DEFAULT_NOTIFICATION_EVENTS } from '@shared/types.js';
import type { ScheduledTaskInfo } from '@shared/types.js';

const EVENT_LABELS: Record<string, string> = {
  critical_finding: 'Critical finding detected',
  warning_finding: 'Warning finding detected',
  weekly_review_ready: 'Weekly review ready',
  action_failed: 'Action failed',
  action_succeeded: 'Action succeeded',
  pending_updates_security: 'Security updates pending',
  forecast_critical: 'Forecast flagged critical item',
};

export function Settings() {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [tgToken, setTgToken] = useState('');
  const [tgChat, setTgChat] = useState('');
  const [tasks, setTasks] = useState<ScheduledTaskInfo[] | null>(null);
  const [emailRecipient, setEmailRecipient] = useState(settings.email_digest_recipient ?? '');
  const [digestHour, setDigestHour] = useState(settings.digest_hour ?? '8');
  const [blockedIPs, setBlockedIPs] = useState<any[]>([]);
  const [updateStatus, setUpdateStatus] = useState<any>({ state: 'idle' });

  async function refreshUpdateStatus() {
    const r = await (api as any).getUpdateStatus?.();
    if (r?.ok) setUpdateStatus(r.data);
  }

  async function checkForUpdatesNow() {
    showToast('Checking for updates…');
    const r = await (api as any).checkForUpdates?.();
    if (r?.ok) setUpdateStatus(r.data);
  }

  async function downloadUpdate() {
    const r = await (api as any).downloadUpdate?.();
    if (r?.ok) setUpdateStatus(r.data);
  }

  async function installUpdate() {
    await (api as any).installUpdateNow?.();
  }

  useEffect(() => {
    refreshUpdateStatus();
    const id = setInterval(refreshUpdateStatus, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api.getSettings();
      if (r.ok) {
        setSettings(r.data);
        setTgToken(r.data.telegram_bot_token ?? '');
        setTgChat(r.data.telegram_chat_id ?? '');
        setEmailRecipient(r.data.email_digest_recipient ?? '');
        setDigestHour(r.data.digest_hour ?? '8');
      }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const r = await api.listScheduledTasks();
      if (r.ok) setTasks(r.data);
    })();
  }, []);

  useEffect(() => {
    (async () => {
      const r = await (api as any).listBlockedIPs?.();
      if (r?.ok) setBlockedIPs(r.data);
    })();
  }, []);

  async function unblockIp(ip: string) {
    const ok = confirm(`Unblock ${ip}?`);
    if (!ok) return;
    const r = await api.runAction({ name: 'unblock_ip', params: { ip } });
    if (r.ok) {
      showToast(`Unblocked ${ip}`);
      const fresh = await (api as any).listBlockedIPs?.();
      if (fresh?.ok) setBlockedIPs(fresh.data);
    } else showToast(`Unblock failed: ${r.error.message}`);
  }

  async function toggleTaskEnabled(name: string, enabled: boolean) {
    const r = await api.setScheduledTaskEnabled(name, enabled);
    if (r.ok) {
      const fresh = await api.listScheduledTasks();
      if (fresh.ok) setTasks(fresh.data);
    } else showToast(`Failed: ${r.error.message}`);
  }

  async function runTaskNow(name: string) {
    const r = await api.runScheduledTaskNow(name);
    if (r.ok) showToast(`Task ${name} triggered`);
    else showToast(`Failed: ${r.error.message}`);
  }

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 5000);
  }

  async function saveSetting(key: string, value: string) {
    await api.setSetting(key, value);
    setSettings(s => ({ ...s, [key]: value }));
  }

  async function connectTelegram() {
    if (!tgToken || !tgChat) { showToast('Enter both token and chat ID'); return; }
    setSaving(true);
    const r = await api.testTelegram(tgToken, tgChat);
    if (r.ok) {
      await saveSetting('telegram_bot_token', tgToken);
      await saveSetting('telegram_chat_id', tgChat);
      await saveSetting('telegram_enabled', '1');
      showToast(`✅ Connected as @${r.data.bot_username}`);
    } else {
      showToast(`Telegram test failed: ${r.error.message}`);
    }
    setSaving(false);
  }

  async function sendTest() {
    const r = await api.sendTestNotification();
    showToast(r.ok ? '✅ Test sent to Telegram' : `Failed: ${r.error.message}`);
  }

  async function toggleEvent(event: string, channel: 'toast' | 'telegram', on: boolean) {
    await saveSetting(`event:${event}:${channel}`, on ? '1' : '0');
  }

  async function toggleTelegramEnabled(on: boolean) {
    await saveSetting('telegram_enabled', on ? '1' : '0');
  }

  if (loading) return <div className="p-6 text-text-secondary">Loading settings…</div>;

  const tgConnected = !!settings.telegram_bot_token && !!settings.telegram_chat_id;
  const tgEnabled = settings.telegram_enabled === '1';

  return (
    <div className="p-5 max-w-4xl">
      <h1 className="text-lg font-bold mb-4">⚙ Settings</h1>

      {/* Telegram */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">📱 Telegram Notifications</h2>
        {tgConnected ? (
          <div>
            <div className="text-xs text-text-secondary mb-3">
              Connected to chat ID <code>{settings.telegram_chat_id}</code>
            </div>
            <label className="flex items-center gap-2 text-xs mb-3">
              <input type="checkbox" checked={tgEnabled} onChange={(e) => toggleTelegramEnabled(e.target.checked)} className="accent-status-good" />
              <span>Telegram notifications enabled</span>
            </label>
            <div className="flex gap-2">
              <button onClick={sendTest} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
                Send test message
              </button>
              <button onClick={() => { setTgToken(''); setTgChat(''); saveSetting('telegram_bot_token', ''); saveSetting('telegram_chat_id', ''); saveSetting('telegram_enabled', '0'); showToast('Disconnected'); }} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600 hover:border-status-crit/40">
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="text-xs text-text-secondary mb-3 space-y-1">
              <div>1. Open <strong>@BotFather</strong> on Telegram and send <code>/newbot</code></div>
              <div>2. Copy the bot token below</div>
              <div>3. Send <code>/start</code> to your bot, then open <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> and copy the <code>"chat":&#123;"id": NUMBER&#125;</code> value</div>
            </div>
            <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">Bot token</label>
            <input
              type="password"
              value={tgToken}
              onChange={(e) => setTgToken(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-600 text-xs mb-2"
              placeholder="1234567890:ABCdef..."
            />
            <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">Chat ID</label>
            <input
              type="text"
              value={tgChat}
              onChange={(e) => setTgChat(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-600 text-xs mb-3"
              placeholder="123456789"
            />
            <button onClick={connectTelegram} disabled={saving} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50">
              {saving ? 'Testing…' : 'Test + Save Connection'}
            </button>
          </div>
        )}
      </section>

      {/* Notification matrix */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">🔔 Notification Matrix</h2>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-text-secondary">
              <th className="text-left pb-2">Event</th>
              <th className="text-center pb-2">Toast</th>
              <th className="text-center pb-2">Telegram</th>
            </tr>
          </thead>
          <tbody>
            {DEFAULT_NOTIFICATION_EVENTS.map((ev) => {
              const toastKey = `event:${ev}:toast`;
              const tgKey = `event:${ev}:telegram`;
              const toastOn = settings[toastKey] !== undefined ? settings[toastKey] === '1' : (ev === 'critical_finding' || ev === 'warning_finding' || ev === 'weekly_review_ready');
              const tgOn = settings[tgKey] !== undefined ? settings[tgKey] === '1' : (ev === 'critical_finding');
              return (
                <tr key={ev} className="border-t border-surface-700">
                  <td className="py-2">{EVENT_LABELS[ev] ?? ev}</td>
                  <td className="py-2 text-center">
                    <input type="checkbox" checked={toastOn} onChange={(e) => toggleEvent(ev, 'toast', e.target.checked)} className="accent-status-good" />
                  </td>
                  <td className="py-2 text-center">
                    <input type="checkbox" checked={tgOn} onChange={(e) => toggleEvent(ev, 'telegram', e.target.checked)} className="accent-status-good" disabled={!tgEnabled} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Quiet hours */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">🌙 Quiet Hours</h2>
        <div className="text-xs text-text-secondary mb-3">Non-critical notifications are silenced during this window. Critical alerts always come through.</div>
        <div className="flex items-center gap-2 text-xs">
          <span>From</span>
          <input type="number" min={0} max={23} value={settings.quiet_hours_start ?? '23'} onChange={(e) => saveSetting('quiet_hours_start', e.target.value)} className="w-16 px-2 py-1 rounded-md bg-surface-900 border border-surface-600" />
          <span>to</span>
          <input type="number" min={0} max={23} value={settings.quiet_hours_end ?? '7'} onChange={(e) => saveSetting('quiet_hours_end', e.target.value)} className="w-16 px-2 py-1 rounded-md bg-surface-900 border border-surface-600" />
          <span className="text-text-secondary">(24h clock)</span>
        </div>
      </section>

      {/* Email digest */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">📧 Email Digest + Quiet Hours Buffering</h2>
        <div className="text-xs text-text-secondary mb-3">
          During quiet hours, non-critical notifications buffer and release as a single morning digest.
          Weekly summary can also ship to your email (requires gws-gmail CLI).
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">Morning digest hour (0-23)</label>
            <input
              type="number" min={0} max={23} value={digestHour}
              onChange={(e) => { setDigestHour(e.target.value); saveSetting('digest_hour', e.target.value); }}
              className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-600 text-xs"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-text-secondary mb-1">Email digest recipient</label>
            <input
              type="email" value={emailRecipient}
              onChange={(e) => { setEmailRecipient(e.target.value); saveSetting('email_digest_recipient', e.target.value); }}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-md bg-surface-900 border border-surface-600 text-xs"
            />
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            onClick={async () => {
              const r = await api.flushBufferedNotifications();
              showToast(r.ok ? `Flushed ${r.data.sent} buffered notifications` : `Failed: ${r.error.message}`);
            }}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600"
          >
            Flush Buffer Now
          </button>
          <button
            onClick={async () => {
              const r = await api.sendWeeklyDigestEmail();
              showToast(r.ok ? '✓ Email digest sent' : `Email failed: ${r.error.message}`);
            }}
            disabled={!emailRecipient}
            className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold disabled:opacity-50"
          >
            Send Weekly Digest Now
          </button>
        </div>
      </section>

      {/* Blocked IPs */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">🚫 Blocked IP Addresses</h2>
        {blockedIPs.length === 0 ? (
          <div className="text-xs text-text-secondary">No PCDoctor-managed block rules. Use Security → Authentication → Block to add them.</div>
        ) : (
          <div className="space-y-1">
            {blockedIPs.map((r, i) => (
              <div key={i} className="flex items-center gap-3 bg-surface-900 border border-surface-700 rounded-md p-2 text-xs">
                <span className={`w-2 h-2 rounded-full ${r.enabled ? 'bg-status-crit' : 'bg-surface-600'}`}></span>
                <code className="flex-1 font-mono">{r.remote_address}</code>
                <span className="text-[10px] text-text-secondary">{r.direction}</span>
                <button onClick={() => unblockIp(r.remote_address)} className="px-2 py-1 rounded bg-surface-700 border border-surface-600 text-[10px] hover:border-status-good/40">Unblock</button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Automatic Threat Response */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">⚔ Automatic Threat Response</h2>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={settings.auto_block_rdp_bruteforce === '1'}
            onChange={(e) => saveSetting('auto_block_rdp_bruteforce', e.target.checked ? '1' : '0')}
          />
          <span>Auto-block IPs generating RDP brute-force (&ge;10 failed logons in 24h)</span>
        </label>
        <div className="text-[10px] text-text-secondary mt-1 pl-6">
          When enabled, Security scans automatically apply the Block-IP action to repeat offenders. You can review + unblock above.
        </div>
      </section>

      {/* Scheduled tasks */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">⏱ Scheduled Tasks</h2>
        {!tasks ? (
          <div className="text-xs text-text-secondary">Loading tasks…</div>
        ) : (
          <div className="space-y-1.5">
            {tasks.map(t => (
              <div key={t.name} className="flex items-center gap-3 bg-surface-900 border border-surface-700 rounded-md p-2 text-xs">
                <div className="flex-1">
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-[10px] text-text-secondary">
                    Status: {t.status}
                    {t.next_run && ` · Next: ${t.next_run}`}
                    {t.last_run && ` · Last: ${t.last_run}`}
                  </div>
                </div>
                <button onClick={() => runTaskNow(t.name)} className="px-2 py-1 rounded-md text-[10px] bg-surface-700 border border-surface-600 hover:border-status-info/40">Run now</button>
                <button onClick={() => toggleTaskEnabled(t.name, t.status === 'Disabled')} className="px-2 py-1 rounded-md text-[10px] bg-surface-700 border border-surface-600 hover:border-status-info/40">
                  {t.status === 'Disabled' ? 'Enable' : 'Disable'}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Diagnostic bundle */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">📦 Diagnostic Bundle</h2>
        <p className="text-xs text-text-secondary mb-3">
          Export a zip of current settings (tokens redacted), last diagnostic report, recent weekly reviews, logs, and action history. Useful for bug reports.
        </p>
        <button
          onClick={async () => {
            const r = await api.exportDiagnosticBundle();
            if (r.ok) showToast(`✓ Bundle at ${r.data.path} (${r.data.size_kb} KB)`);
            else showToast(`Export failed: ${r.error.message}`);
          }}
          className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold"
        >
          Export Diagnostic Bundle
        </button>
      </section>

      {/* Auto-Update */}
      <section className="mb-6 bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">🔄 Auto-Update</h2>
        <div className="text-xs text-text-secondary mb-3">
          Checks <code>\\192.168.50.226\Backups\pcdoctor-updates</code> every 6 hours.
          New builds dropped there auto-download (with your approval).
        </div>
        <div className="bg-surface-900 border border-surface-700 rounded-md p-3 mb-3">
          <div className="text-[10px] uppercase tracking-wider text-text-secondary mb-1">Status</div>
          <div className="text-sm font-semibold">
            {updateStatus.state === 'idle' && 'Idle'}
            {updateStatus.state === 'checking' && 'Checking…'}
            {updateStatus.state === 'available' && `Update ${updateStatus.version} available`}
            {updateStatus.state === 'downloading' && `Downloading ${updateStatus.progress_pct ?? 0}%`}
            {updateStatus.state === 'ready' && `Ready to install ${updateStatus.version}`}
            {updateStatus.state === 'not_available' && 'On latest version'}
            {updateStatus.state === 'error' && `Error: ${updateStatus.message}`}
          </div>
          {updateStatus.message && updateStatus.state !== 'error' && (
            <div className="text-[10px] text-text-secondary mt-1">{updateStatus.message}</div>
          )}
          {updateStatus.state === 'downloading' && (
            <div className="mt-2 h-1.5 bg-surface-700 rounded-full overflow-hidden">
              <div className="h-full bg-status-info transition-all" style={{ width: `${updateStatus.progress_pct ?? 0}%` }} />
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <button onClick={checkForUpdatesNow} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">Check Now</button>
          {updateStatus.state === 'available' && (
            <button onClick={downloadUpdate} className="px-3 py-1.5 rounded-md text-xs bg-[#238636] text-white font-semibold">Download Update</button>
          )}
          {updateStatus.state === 'ready' && (
            <button onClick={installUpdate} className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-semibold">Install and Restart</button>
          )}
        </div>
      </section>

      {/* About */}
      <section className="bg-surface-800 border border-surface-600 rounded-lg p-5">
        <h2 className="text-sm font-bold mb-3">About</h2>
        <div className="text-xs text-text-secondary space-y-1">
          <div>PCDoctor Workbench <strong>v1.0.0</strong></div>
          <div>Built with Electron + React + TypeScript + SQLite</div>
          <div>Spec: <code>docs/superpowers/specs/2026-04-17-pcdoctor-workbench-design.md</code></div>
          <div>Repo: <code>pcdoctor-workbench/</code></div>
        </div>
      </section>

      {toast && (
        <div className="fixed bottom-4 right-4 bg-surface-700 border border-surface-600 rounded-lg px-4 py-3 text-sm shadow-xl">{toast}</div>
      )}
    </div>
  );
}
