import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';
import { DEFAULT_NOTIFICATION_EVENTS } from '@shared/types.js';

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

  useEffect(() => {
    (async () => {
      const r = await api.getSettings();
      if (r.ok) {
        setSettings(r.data);
        setTgToken(r.data.telegram_bot_token ?? '');
        setTgChat(r.data.telegram_chat_id ?? '');
      }
      setLoading(false);
    })();
  }, []);

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
