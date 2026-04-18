import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron';
import path from 'node:path';
import type { Severity } from '@shared/types.js';

let tray: Tray | null = null;
let currentSeverity: Severity = 'good';
let getWindow: () => BrowserWindow | null = () => null;

function iconPath(severity: Severity): string {
  const file =
    severity === 'crit' ? 'tray-red.ico' :
    severity === 'warn' ? 'tray-yellow.ico' :
    'tray-green.ico';
  // In dev mode, icons are in project-root/resources/icons
  // In production, they're in process.resourcesPath/icons
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.join(app.getAppPath(), 'resources', 'icons');
  return path.join(base, file);
}

export function createTray(opts: { getWindow: () => BrowserWindow | null; onQuit: () => void }) {
  getWindow = opts.getWindow;
  const img = nativeImage.createFromPath(iconPath('good'));
  tray = new Tray(img);
  tray.setToolTip('PCDoctor Workbench');

  tray.on('click', () => {
    const win = getWindow();
    if (!win) return;
    if (win.isVisible()) win.hide();
    else { win.show(); win.focus(); }
  });

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Open Dashboard', click: () => { const w = getWindow(); w?.show(); w?.focus(); } },
    { type: 'separator' },
    { label: 'Quit PCDoctor Workbench', click: () => { opts.onQuit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

export function updateTraySeverity(severity: Severity) {
  if (!tray) return;
  if (severity === currentSeverity) return;
  currentSeverity = severity;
  tray.setImage(nativeImage.createFromPath(iconPath(severity)));
  tray.setToolTip(
    severity === 'crit' ? 'PCDoctor - CRITICAL' :
    severity === 'warn' ? 'PCDoctor - ATTENTION' :
    'PCDoctor - OK',
  );
}
