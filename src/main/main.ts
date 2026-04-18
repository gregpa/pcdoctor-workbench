import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createTray, updateTraySeverity } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { getStatus } from './pcdoctorBridge.js';
import { POLL_INTERVAL_MS } from './constants.js';
import { startTelegramPolling, stopTelegramPolling, answerCallbackQuery, editMessageText } from './telegramBridge.js';
import { runAction } from './actionRunner.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';

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
    show: false,     // Start hidden — tray click reveals
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
}

async function backgroundPoll() {
  try {
    const status = await getStatus();
    updateTraySeverity(status.overall_severity);
  } catch {
    // Silent — backend may not have run yet. Tray stays last-known color.
  }
}

app.whenReady().then(() => {
  registerIpcHandlers();

  // Auto-register PCDoctor scheduled tasks (best-effort, once per session)
  (async () => {
    try {
      const { runPowerShellScript } = await import('./scriptRunner.js');
      await runPowerShellScript('Register-All-Tasks.ps1', ['-JsonOutput'], { timeoutMs: 30_000 });
    } catch { /* non-fatal */ }
  })();

  createWindow();
  createTray({
    getWindow: () => mainWindow,
    onQuit: () => {
      (app as any).isQuitting = true;
      if (pollTimer) clearInterval(pollTimer);
      stopTelegramPolling();
      app.quit();
    },
  });

  backgroundPoll();
  pollTimer = setInterval(backgroundPoll, POLL_INTERVAL_MS);

  // Start Telegram callback polling
  startTelegramPolling(async (q) => {
    if (!q.data) { await answerCallbackQuery(q.id, 'Invalid request'); return; }
    const parts = q.data.split('|');
    const kind = parts[0];

    if (kind === 'dismiss') {
      await answerCallbackQuery(q.id, '✓ Dismissed');
      if (q.message) {
        await editMessageText(q.message.chat.id, q.message.message_id, '✖ <i>Dismissed from Telegram</i>');
      }
      return;
    }

    if (kind === 'act') {
      const actionName = parts[1] as ActionName;
      const def = ACTIONS[actionName];
      if (!def) { await answerCallbackQuery(q.id, 'Unknown action'); return; }
      // Telegram actions are blocked for Tier A destructive by default — confirm-on-phone path
      if (def.confirm_level === 'destructive') {
        await answerCallbackQuery(q.id, '⚠ Destructive action — use the dashboard to confirm');
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
    }
  });
});

app.on('window-all-closed', () => {
  // Don't quit — tray keeps app alive.
});

app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
