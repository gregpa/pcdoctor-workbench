import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { createTray, updateTraySeverity } from './tray.js';
import { registerIpcHandlers } from './ipc.js';
import { getStatus } from './pcdoctorBridge.js';
import { POLL_INTERVAL_MS } from './constants.js';

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
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
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
  createWindow();
  createTray({
    getWindow: () => mainWindow,
    onQuit: () => {
      (app as any).isQuitting = true;
      if (pollTimer) clearInterval(pollTimer);
      app.quit();
    },
  });

  backgroundPoll();
  pollTimer = setInterval(backgroundPoll, POLL_INTERVAL_MS);
});

app.on('window-all-closed', () => {
  // Don't quit — tray keeps app alive.
});

app.on('second-instance', () => {
  mainWindow?.show();
  mainWindow?.focus();
});
