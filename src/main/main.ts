import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';
import { createTray, updateTraySeverity } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { getStatus } from './pcdoctorBridge.js';
import { POLL_INTERVAL_MS } from './constants.js';
import { startTelegramPolling, stopTelegramPolling, answerCallbackQuery, editMessageText, sendTelegramMessage } from './telegramBridge.js';
import { runAction } from './actionRunner.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';
import { startClaudeBridgeWatcher } from './claudeBridgeWatcher.js';
import { flushBufferedNotifications, getDigestHour } from './notifier.js';
import { initAutoUpdater, checkForUpdates } from './autoUpdater.js';
import { registerPtyIpc, killAllPtySessions } from './ptyBridge.js';
import { startAutopilotEngine, stopAutopilotEngine, getAutopilotActivity } from './autopilotEngine.js';
import { suppressAutopilotRule, insertAutopilotActivity } from './dataStore.js';

// Hide dock icon / single-instance check
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

let mainWindow: BrowserWindow | null = null;
let pollTimer: NodeJS.Timeout | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 980,
    show: false,     // Start hidden - tray click reveals
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  }

  mainWindow.on('close', (e) => {
    // Minimize to tray instead of quit
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Reviewer P1: hard nav-guards. Any target="_blank" link opens in the
  // user's default browser rather than inside the Electron window. Any
  // in-window navigation to a non-self origin is blocked and redirected to
  // the external browser. Defense-in-depth beyond CSP (belt + suspenders).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    try {
      const parsed = new URL(url);
      const devUrl = process.env.VITE_DEV_SERVER_URL;
      const allowedOrigin = devUrl ? new URL(devUrl).origin : null;
      const isSelfOrigin = allowedOrigin && parsed.origin === allowedOrigin;
      const isFile = url.startsWith('file://');
      if (!isSelfOrigin && !isFile) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    try {
      const parsed = new URL(url);
      if (parsed.origin !== 'file://' && !url.startsWith('file://') && !process.env.VITE_DEV_SERVER_URL) {
        event.preventDefault();
      }
    } catch { event.preventDefault(); }
  });

  // Browser-style zoom via Ctrl+=/Ctrl+-/Ctrl+0. Also supports Ctrl+scroll.
  // Persisted to the settings table so zoom survives restarts.
  const wc = mainWindow.webContents;
  const clamp = (n: number) => Math.max(-3, Math.min(5, n));

  wc.on('did-finish-load', async () => {
    try {
      const { getSetting } = await import('./dataStore.js');
      const saved = parseFloat(getSetting('ui_zoom_level') ?? '0');
      if (!isNaN(saved)) wc.setZoomLevel(clamp(saved));
    } catch { /* non-fatal */ }
  });

  const saveZoom = async (level: number) => {
    try {
      const { setSetting } = await import('./dataStore.js');
      setSetting('ui_zoom_level', String(level));
    } catch { /* non-fatal */ }
  };

  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown' || !input.control) return;
    if (input.key === '=' || input.key === '+') {
      const lvl = clamp(wc.getZoomLevel() + 0.5);
      wc.setZoomLevel(lvl); saveZoom(lvl);
    } else if (input.key === '-') {
      const lvl = clamp(wc.getZoomLevel() - 0.5);
      wc.setZoomLevel(lvl); saveZoom(lvl);
    } else if (input.key === '0') {
      wc.setZoomLevel(0); saveZoom(0);
    }
  });

  wc.setVisualZoomLevelLimits(1, 1); // disable pinch-zoom; Ctrl+wheel still works
}

async function backgroundPoll() {
  try {
    const status = await getStatus();
    updateTraySeverity(status.overall_severity);
  } catch {
    // Silent - backend may not have run yet. Tray stays last-known color.
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();

  // Auto-register PCDoctor scheduled tasks (best-effort, once per session).
  // v2.3.0 B2: on the first launch of 2.3.0, force-recreate existing tasks so
  // the user/SYSTEM context split applies. This rewrites /RU for tasks that
  // used to run as SYSTEM and need to read HKCU.
  (async () => {
    try {
      const { runPowerShellScript } = await import('./scriptRunner.js');
      const { getSetting, setSetting } = await import('./dataStore.js');
      const lastMigration = getSetting('last_task_migration_version');
      const args = ['-JsonOutput'];
      if (lastMigration !== '2.3.0') {
        args.push('-ForceRecreate');
      }
      await runPowerShellScript('Register-All-Tasks.ps1', args, { timeoutMs: 60_000 });
      if (lastMigration !== '2.3.0') {
        setSetting('last_task_migration_version', '2.3.0');
      }
    } catch { /* non-fatal */ }
  })();

  // v2.3.0 first-run self-test: fires once per major version, only if Telegram
  // is configured. Also bumps the selftest_version marker so 2.3.0 installs
  // ping the channel to confirm tokens still work after the upgrade.
  (async () => {
    try {
      const { getSetting, setSetting } = await import('./dataStore.js');
      const lastSelftest = getSetting('last_selftest_version');
      if (lastSelftest !== '2.3.0') {
        const rawToken = getSetting('telegram_bot_token');
        if (rawToken) {
          const { sendTelegramMessage, makeCallbackData } = await import('./telegramBridge.js');
          const r = await sendTelegramMessage(
            '✅ <b>PCDoctor Workbench 2.3.0 installed</b>\n\n' +
            'New: Autopilot rule editor, batch startup picker, RAM pressure panel.\n' +
            'Tap a button below to verify this channel still works.',
            [[
              { text: '✓ Working — dismiss', callback_data: makeCallbackData('selftest_confirm') },
              { text: '🔧 Open Dashboard', callback_data: makeCallbackData('selftest_dashboard') },
            ]],
          );
          if (!r.ok) {
            // Surface dashboard banner via a stored setting — the renderer can poll this
            setSetting('selftest_banner', `⚠ Telegram self-test failed: ${r.error ?? 'unknown error'}. Re-test from Settings > Notifications.`);
          }
          // Mark regardless of success so we don't spam on subsequent launches
          setSetting('last_selftest_version', '2.3.0');
        } else {
          // No Telegram configured — still stamp so we don't check every launch.
          setSetting('last_selftest_version', '2.3.0');
        }
      }
    } catch { /* non-fatal — never block startup */ }
  })();

  createWindow();
  createTray({
    getWindow: () => mainWindow,
    onQuit: () => {
      (app as any).isQuitting = true;
      if (pollTimer) clearInterval(pollTimer);
      stopTelegramPolling();
      stopAutopilotEngine();
      killAllPtySessions();
      app.quit();
    },
  });

  try { registerPtyIpc(() => mainWindow); } catch (e) { console.error('pty init failed', e); }

  // Auto-updater - init + check on startup + every 6 hours
  if (app.isPackaged) {
    initAutoUpdater(() => mainWindow);
    setTimeout(() => { checkForUpdates().catch(() => {}); }, 30_000);
    setInterval(() => { checkForUpdates().catch(() => {}); }, 6 * 60 * 60 * 1000);
  }

  backgroundPoll();
  pollTimer = setInterval(backgroundPoll, POLL_INTERVAL_MS);

  // Start Telegram callback polling
  startClaudeBridgeWatcher(() => mainWindow);
  startAutopilotEngine();

  startTelegramPolling(async (q) => {
    if (!q.data) { await answerCallbackQuery(q.id, 'Invalid request'); return; }
    const parts = q.data.split('|');
    const kind = parts[0];

    if (kind === 'selftest_confirm') {
      const { setSetting } = await import('./dataStore.js');
      setSetting('last_selftest_version', '2.3.0');
      setSetting('selftest_banner', '');  // clear any failure banner
      await answerCallbackQuery(q.id, '✅ Confirmed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '✅ Confirmed. Autopilot alerts will appear here.');
      }
      return;
    }

    if (kind === 'selftest_dashboard') {
      await answerCallbackQuery(q.id, '🔧 Open PCDoctor Workbench on your PC to view the Dashboard.');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '🔧 Open <b>PCDoctor Workbench</b> on your PC to view the Dashboard.\n\n' +
          'The app lives in your system tray (bottom-right). Click it to open.');
      }
      return;
    }

    if (kind === 'tgtest_ok') {
      // Callback for api:sendTelegramTestFull "✓ Received" button
      const { setSetting } = await import('./dataStore.js');
      setSetting('telegram_last_good_ts', String(Date.now()));
      await answerCallbackQuery(q.id, '✅ Telegram verified');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✅ Telegram verified.');
      }
      return;
    }

    if (kind === 'tgtest_fail') {
      // Callback for api:sendTelegramTestFull "❌ Buttons don't work" button
      const { startActionLog, finishActionLog } = await import('./dataStore.js');
      const logId = startActionLog({
        action_name: 'telegram_test' as any,
        action_label: 'Telegram full round-trip test',
        status: 'running',
        triggered_by: 'user',
      });
      finishActionLog(logId, {
        status: 'error',
        duration_ms: 0,
        result: { telegram_callback_failed: true },
        error_message: 'User reported button callback failure',
      });
      await answerCallbackQuery(q.id, '⚠ Recorded — check dashboard');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id,
          '⚠ Failure recorded. Check Settings > Notifications in PCDoctor Workbench.');
      }
      return;
    }

    if (kind === 'dismiss') {
      await answerCallbackQuery(q.id, '✓ Dismissed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✖ <i>Dismissed from Telegram</i>');
      }
      return;
    }

    // ---- Autopilot inline keyboard callbacks (v2.2.0) ----

    if (kind === 'autopilot') {
      const actionName = parts[1] as ActionName;
      const ruleId = parts[2] ?? '';
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        insertAutopilotActivity({
          rule_id: ruleId || `manual:${actionName}`,
          tier: 3,
          action_name: actionName,
          outcome: result.success ? 'auto_run' : 'error',
          duration_ms: result.duration_ms,
          message: result.success ? 'ran from Telegram button' : (result.error?.message ?? 'error'),
        });
        const bytes = (result.result as any)?.bytes_freed;
        const bytesTxt = typeof bytes === 'number' ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB freed)` : '';
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed${bytesTxt}`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }

    if (kind === 'ap_snooze') {
      const ruleId = parts[1] ?? '';
      const until = Date.now() + 24 * 60 * 60 * 1000;
      suppressAutopilotRule(ruleId, until);
      insertAutopilotActivity({
        rule_id: ruleId,
        tier: 3,
        outcome: 'suppressed',
        message: 'snoozed 24h from Telegram',
      });
      await answerCallbackQuery(q.id, '⏸ Snoozed 24h');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '⏸ <i>Snoozed 24h</i>');
      }
      return;
    }

    if (kind === 'ap_dismiss') {
      const ruleId = parts[1] ?? '';
      insertAutopilotActivity({
        rule_id: ruleId,
        tier: 3,
        outcome: 'suppressed',
        message: 'dismissed from Telegram',
      });
      await answerCallbackQuery(q.id, '✓ Dismissed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✓ <i>Dismissed</i>');
      }
      return;
    }

    if (kind === 'act') {
      const actionName = parts[1] as ActionName;
      const findingHash = parts[2];
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      if (def.confirm_level === 'destructive') {
        // Send a confirmation message rather than executing
        await answerCallbackQuery(q.id, '⚠ Destructive - confirm required');
        if (q.message) {
          const { sendTelegramMessage, makeCallbackData } = await import('./telegramBridge.js');
          await sendTelegramMessage(
            `⚠️ <b>Confirm destructive action</b>\n\n<b>${def.label}</b>\n${def.tooltip}\n\n` +
            `Rollback: Tier ${def.rollback_tier}\n` +
            `Tap <b>Confirm</b> below to proceed, or Cancel to skip.`,
            [[
              { text: `✓ Confirm ${def.label}`, callback_data: makeCallbackData('act_confirmed', actionName, findingHash) },
              { text: '✖ Cancel', callback_data: makeCallbackData('dismiss', findingHash) },
            ]]
          );
        }
        return;
      }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed in ${result.duration_ms}ms`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }

    // (autopilot handlers continued — act_confirmed below is pre-existing)

    if (kind === 'act_confirmed') {
      const actionName = parts[1] as ActionName;
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      await answerCallbackQuery(q.id, `Running ${def.label}…`);
      try {
        const result = await runAction({ name: actionName, triggered_by: 'telegram' });
        const msg = result.success
          ? `✓ <b>${def.label}</b> completed in ${result.duration_ms}ms`
          : `✗ <b>${def.label}</b> failed: ${result.error?.message ?? 'unknown'}`;
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, msg);
        }
      } catch (e: any) {
        if (q.message) {
          await editMessageText(q.message.chat.id, q.message.message_id, `✗ Error: ${e?.message ?? 'unknown'}`);
        }
      }
      return;
    }
  }, async (m) => {
    // Text message handler — we only care about /status (and its aliases).
    if (!m.text) return;
    const cmd = m.text.trim().toLowerCase();
    if (cmd === '/status' || cmd === 'status') {
      try {
        const s = await getStatus();
        const activity = getAutopilotActivity(7);
        const autoRuns = activity.filter(a => a.outcome === 'auto_run').length;
        const alerts = activity.filter(a => a.outcome === 'alerted').length;
        const bytesFreed = activity.reduce((sum, a) => sum + (a.bytes_freed ?? 0), 0);
        const critCount = s.findings.filter(f => f.severity === 'critical').length;
        const warnCount = s.findings.filter(f => f.severity === 'warning').length;
        const reply =
          `<b>PCDoctor status — ${s.host}</b>\n` +
          `Overall: <b>${s.overall_label}</b> (${s.overall_severity})\n` +
          `Findings: ${critCount} crit · ${warnCount} warn\n\n` +
          `<b>Autopilot (7d):</b>\n` +
          `• Auto-runs: ${autoRuns}\n` +
          `• Alerts: ${alerts}\n` +
          `• Freed: ${(bytesFreed / 1024 / 1024).toFixed(1)} MB\n` +
          `\nGenerated ${new Date(s.generated_at * 1000).toLocaleString()}`;
        await sendTelegramMessage(reply);
      } catch (e: any) {
        await sendTelegramMessage(`⚠ Status unavailable: ${e?.message ?? 'unknown'}`);
      }
    }
  });

  // Morning digest flush timer - runs every minute, triggers when hour matches digest_hour
  let lastFlushHour = -1;
  setInterval(async () => {
    const now = new Date();
    const hour = now.getHours();
    const digestHour = getDigestHour();
    if (hour === digestHour && lastFlushHour !== hour) {
      lastFlushHour = hour;
      try { await flushBufferedNotifications(); } catch {}
    }
    // Reset at next day
    if (hour !== digestHour) lastFlushHour = -1;
  }, 60_000);
});

app.on('window-all-closed', () => {
  // Don't quit - tray keeps app alive.
});

app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
