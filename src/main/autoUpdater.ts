import { app, BrowserWindow, dialog, Notification } from 'electron';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'not_available';
  version?: string;
  message?: string;
  progress_pct?: number;
}

let currentStatus: UpdateStatus = { state: 'idle' };
let statusListeners: Array<(s: UpdateStatus) => void> = [];

function setStatus(s: UpdateStatus) {
  currentStatus = s;
  for (const cb of statusListeners) {
    try { cb(s); } catch {}
  }
}

export function subscribeStatus(cb: (s: UpdateStatus) => void): () => void {
  statusListeners.push(cb);
  cb(currentStatus);
  return () => { statusListeners = statusListeners.filter(c => c !== cb); };
}

export function getStatus(): UpdateStatus { return currentStatus; }

export function initAutoUpdater(getWindow: () => BrowserWindow | null): void {
  autoUpdater.autoDownload = false;       // ask user before downloading
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  // SECURITY NOTE (W9): The update channel is a NAS share that anyone with network write
  // access can publish to. electron-updater verifies the installer's Authenticode signature
  // if signtool was applied at build time, but this build pipeline is currently unsigned.
  // For a hardened release, sign installers with a code-signing cert and set publisherName
  // below to pin the expected signer. Blast radius is limited to the home lab today.

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-available', (info) => {
    setStatus({ state: 'available', version: info.version, message: `Update ${info.version} available` });
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: 'PCDoctor Workbench update available',
          body: `Version ${info.version} is available. Open the app to download.`,
        }).show();
      }
    } catch {}
  });
  autoUpdater.on('update-not-available', (info) => {
    setStatus({ state: 'not_available', version: info?.version, message: 'You are on the latest version' });
  });
  autoUpdater.on('download-progress', (prog) => {
    setStatus({
      state: 'downloading',
      progress_pct: Math.round(prog.percent ?? 0),
      message: `Downloading… ${Math.round(prog.percent ?? 0)}%`,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'ready', version: info.version, message: `Update ${info.version} ready to install` });
    const win = getWindow();
    if (win) {
      dialog.showMessageBox(win, {
        type: 'info',
        title: 'Update Ready',
        message: `PCDoctor Workbench ${info.version} is ready to install.`,
        detail: 'Click "Install and Restart" to apply the update now, or "Later" to install on next quit.',
        buttons: ['Install and Restart', 'Later'],
        defaultId: 0,
      }).then((r) => {
        if (r.response === 0) autoUpdater.quitAndInstall();
      });
    }
  });
  autoUpdater.on('error', (err) => {
    setStatus({ state: 'error', message: err?.message ?? 'Update error' });
  });
}

export async function checkForUpdates(): Promise<void> {
  try { await autoUpdater.checkForUpdates(); } catch (e: any) {
    setStatus({ state: 'error', message: e?.message ?? 'Update check failed' });
  }
}

export async function downloadUpdate(): Promise<void> {
  try { await autoUpdater.downloadUpdate(); } catch (e: any) {
    setStatus({ state: 'error', message: e?.message ?? 'Download failed' });
  }
}

export function installNow(): void {
  try { autoUpdater.quitAndInstall(); } catch {}
}
