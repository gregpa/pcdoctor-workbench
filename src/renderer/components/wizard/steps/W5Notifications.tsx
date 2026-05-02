/**
 * W5 Notifications — fifth step of the first-run wizard (index 4).
 *
 * Lets the user optionally configure Telegram push notifications and
 * set quiet hours for notification suppression.
 *
 * Settings written on unmount (step change):
 *   telegram_enabled, telegram_bot_token, telegram_chat_id,
 *   quiet_hours_start, quiet_hours_end
 */

import { useEffect, useState, useCallback } from 'react';
import { useWizard } from '../WizardContext.js';

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function W5Notifications() {
  const { state, dispatch, markComplete } = useWizard();

  // -- Telegram local state --
  const [tgEnabled, setTgEnabled] = useState(state.telegramEnabled);
  const [tgToken, setTgToken] = useState(state.telegramBotToken);
  const [tgChatId, setTgChatId] = useState(state.telegramChatId);
  const [showToken, setShowToken] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // -- Quiet hours local state --
  const [qhStart, setQhStart] = useState(state.quietHoursStart);
  const [qhEnd, setQhEnd] = useState(state.quietHoursEnd);

  // -- Save all settings and mark complete on unmount --
  const saveSettings = useCallback(async () => {
    try {
      await Promise.all([
        window.api.setSetting('telegram_enabled', tgEnabled ? '1' : '0'),
        window.api.setSetting('telegram_bot_token', tgToken),
        window.api.setSetting('telegram_chat_id', tgChatId),
        window.api.setSetting('quiet_hours_start', String(qhStart)),
        window.api.setSetting('quiet_hours_end', String(qhEnd)),
      ]);
    } catch {
      // Non-fatal — settings can be adjusted later from the Settings page.
    }

    dispatch({ type: 'SET_FIELD', field: 'telegramEnabled', value: tgEnabled });
    dispatch({ type: 'SET_FIELD', field: 'telegramBotToken', value: tgToken });
    dispatch({ type: 'SET_FIELD', field: 'telegramChatId', value: tgChatId });
    dispatch({ type: 'SET_FIELD', field: 'quietHoursStart', value: qhStart });
    dispatch({ type: 'SET_FIELD', field: 'quietHoursEnd', value: qhEnd });
  }, [tgEnabled, tgToken, tgChatId, qhStart, qhEnd, dispatch]);

  useEffect(() => {
    return () => {
      void saveSettings();
      markComplete(4);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSettings]);

  // -- Test Connection handler --
  async function handleTestConnection() {
    if (!tgToken || !tgChatId) return;
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.api.testTelegram(tgToken, tgChatId);
      if (r.ok) {
        setTestResult({ ok: true, message: `Connected as @${r.data.bot_username ?? 'unknown'}` });
      } else {
        setTestResult({ ok: false, message: r.error.message });
      }
    } catch (e) {
      setTestResult({ ok: false, message: e instanceof Error ? e.message : 'Connection failed' });
    } finally {
      setTesting(false);
    }
  }

  // -- Format hour for display --
  function formatHour(h: number): string {
    if (h === 0) return '12:00 AM';
    if (h < 12) return `${h}:00 AM`;
    if (h === 12) return '12:00 PM';
    return `${h - 12}:00 PM`;
  }

  return (
    <div className="flex flex-col gap-5 py-2">
      {/* ── Section A: Telegram ── */}
      <div>
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
            {'📱'} Telegram Notifications
          </h2>
          <button
            type="button"
            role="switch"
            aria-checked={tgEnabled}
            aria-label="Enable Telegram notifications"
            onClick={() => {
              setTgEnabled(!tgEnabled);
              setTestResult(null);
            }}
            className={`relative w-11 h-6 rounded-full transition-colors ${
              tgEnabled ? 'bg-status-info' : 'bg-surface-600'
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
                tgEnabled ? 'translate-x-5' : ''
              }`}
            />
          </button>
        </div>

        {!tgEnabled ? (
          <p className="text-sm text-text-secondary mt-2">
            Notifications disabled. You can set this up later in Settings.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3">
            {/* Setup guide */}
            <div className="rounded-lg border border-surface-600 bg-surface-700/50 px-4 py-3">
              <p className="text-xs font-semibold text-text-secondary uppercase tracking-wide mb-1.5">
                Setup Guide
              </p>
              <ol className="text-xs text-text-secondary space-y-1 list-decimal list-inside">
                <li>Open Telegram, search <strong>@BotFather</strong></li>
                <li>Send <strong>/newbot</strong>, follow prompts, copy the token</li>
                <li>Paste the token below</li>
                <li>Send any message to your new bot, then enter the Chat ID</li>
              </ol>
            </div>

            {/* Bot Token input */}
            <div>
              <label className="text-sm text-text-primary font-medium" htmlFor="tg-token">
                Bot Token
              </label>
              <div className="relative mt-1">
                <input
                  id="tg-token"
                  type={showToken ? 'text' : 'password'}
                  value={tgToken}
                  onChange={(e) => setTgToken(e.target.value)}
                  placeholder="123456:ABC-DEF..."
                  className="w-full px-3 py-2 pr-10 rounded-md border border-surface-600 bg-surface-800 text-text-primary text-sm"
                />
                <button
                  type="button"
                  aria-label={showToken ? 'Hide token' : 'Show token'}
                  onClick={() => setShowToken(!showToken)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-text-secondary hover:text-text-primary text-sm"
                >
                  {showToken ? '🙈' : '👁'}
                </button>
              </div>
            </div>

            {/* Chat ID input */}
            <div>
              <label className="text-sm text-text-primary font-medium" htmlFor="tg-chat-id">
                Chat ID
              </label>
              <input
                id="tg-chat-id"
                type="text"
                value={tgChatId}
                onChange={(e) => setTgChatId(e.target.value)}
                placeholder="e.g. 123456789"
                className="w-full mt-1 px-3 py-2 rounded-md border border-surface-600 bg-surface-800 text-text-primary text-sm"
              />
            </div>

            {/* Test Connection button */}
            <div className="flex items-center gap-3">
              <button
                type="button"
                disabled={testing || !tgToken || !tgChatId}
                onClick={handleTestConnection}
                className="px-4 py-2 rounded-md bg-status-info text-white text-sm font-semibold hover:opacity-90 transition disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>

              {testResult && (
                <span className={`text-sm ${testResult.ok ? 'text-status-good' : 'text-status-warn'}`}>
                  {testResult.ok ? `✓ ${testResult.message}` : testResult.message}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Section B: Quiet Hours ── */}
      <div className="mt-1">
        <h2 className="text-lg font-bold text-text-primary flex items-center gap-2">
          {'🌙'} Quiet Hours
        </h2>
        <p className="text-sm text-text-secondary mt-0.5">
          Suppress non-critical notifications during these hours.
        </p>

        <div className="flex items-center gap-4 mt-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-text-secondary" htmlFor="qh-start">Start</label>
            <input
              id="qh-start"
              type="number"
              min={0}
              max={23}
              value={qhStart}
              onChange={(e) => setQhStart(Math.max(0, Math.min(23, Number(e.target.value))))}
              className="w-16 px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm text-center"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-text-secondary" htmlFor="qh-end">End</label>
            <input
              id="qh-end"
              type="number"
              min={0}
              max={23}
              value={qhEnd}
              onChange={(e) => setQhEnd(Math.max(0, Math.min(23, Number(e.target.value))))}
              className="w-16 px-2 py-1 rounded border border-surface-600 bg-surface-800 text-text-primary text-sm text-center"
            />
          </div>
        </div>

        <p className="text-xs text-text-secondary mt-2">
          Quiet from {formatHour(qhStart)} to {formatHour(qhEnd)}
        </p>
      </div>
    </div>
  );
}
