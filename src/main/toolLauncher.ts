import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ToolStatus } from '@shared/types.js';
import { TOOLS } from '@shared/tools.js';

function expandEnvVars(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
}

/** Returns true if `winget list --id <id>` reports the package installed. */
function isWingetInstalled(wingetId: string): boolean {
  try {
    const r = spawnSync('winget', ['list', '--id', wingetId, '--exact', '--source', 'winget'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
    });
    if (r.status !== 0 || !r.stdout) return false;
    // winget list prints the id only when a match exists
    return r.stdout.toLowerCase().includes(wingetId.toLowerCase());
  } catch { return false; }
}

/** Fast-path detection of MSIX/Store apps: checks both the user-scoped and machine-scoped
 *  Packages directories for the family name. Falls back to Get-AppxPackage via PowerShell
 *  if the directory probe yields nothing (covers edge cases like non-standard install roots). */
function isMsixInstalled(packageFamily: string): boolean {
  const userPackages = path.join(process.env.LOCALAPPDATA ?? '', 'Packages', packageFamily);
  if (existsSync(userPackages)) return true;
  // Secondary probe: WindowsApps is the machine-scoped MSIX root (not always readable from user context)
  const machinePackages = path.join('C:\\Program Files\\WindowsApps', packageFamily);
  if (existsSync(machinePackages)) return true;
  // Fallback: ask PowerShell (slower, ~500ms)
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `if (Get-AppxPackage -Name '${packageFamily.split('_')[0]}' -ErrorAction SilentlyContinue) { 'yes' }`,
    ], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
    return (r.stdout ?? '').trim() === 'yes';
  } catch { return false; }
}

export function getToolStatus(toolId: string): ToolStatus {
  const def = TOOLS[toolId];
  if (!def) return { id: toolId, installed: false, resolved_path: null };
  // Fast path: probe known file locations
  for (const candidate of def.detect_paths) {
    const resolved = expandEnvVars(candidate);
    if (existsSync(resolved)) return { id: toolId, installed: true, resolved_path: resolved };
  }
  // MSIX apps: presence of Packages dir or AppxPackage
  if (def.msix_app_id && def.msix_package_family && isMsixInstalled(def.msix_package_family)) {
    return { id: toolId, installed: true, resolved_path: `shell:AppsFolder\\${def.msix_app_id}` };
  }
  // Fallback: ask winget
  if (def.winget_id && isWingetInstalled(def.winget_id)) {
    return { id: toolId, installed: true, resolved_path: null };
  }
  return { id: toolId, installed: false, resolved_path: null };
}

export function listAllToolStatuses(): ToolStatus[] {
  return Object.keys(TOOLS).map(getToolStatus);
}

export async function launchTool(toolId: string, modeId: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const def = TOOLS[toolId];
  if (!def) return { ok: false, error: `Unknown tool: ${toolId}` };
  const mode = def.launch_modes.find(m => m.id === modeId) ?? def.launch_modes[0];
  if (!mode) return { ok: false, error: 'No launch mode defined' };
  const status = getToolStatus(toolId);

  // MSIX apps: launch via explorer.exe shell:AppsFolder\<AppID>
  if (status.installed && def.msix_app_id) {
    try {
      const child = spawn('explorer.exe', [`shell:AppsFolder\\${def.msix_app_id}`], {
        detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'MSIX launch failed' };
    }
  }

  // If detection returned installed-via-winget but no resolved_path, try launching via winget
  if (status.installed && !status.resolved_path && def.winget_id) {
    try {
      const child = spawn('winget', ['run', '--id', def.winget_id], {
        detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.unref();
      return { ok: true, pid: child.pid };
    } catch (e: any) {
      // Fall through to the path-based path even though we know it won't work
    }
  }

  if (!status.installed || !status.resolved_path) {
    return { ok: false, error: `Tool not installed: ${def.name}` };
  }
  try {
    const child = spawn(status.resolved_path, mode.args, {
      detached: mode.detached ?? true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();
    return { ok: true, pid: child.pid };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Launch failed' };
  }
}

export async function installToolViaWinget(toolId: string): Promise<{ ok: boolean; error?: string }> {
  const def = TOOLS[toolId];
  if (!def?.winget_id) return { ok: false, error: 'No winget_id configured for this tool' };
  return new Promise((resolve) => {
    const child = spawn('winget', ['install', '--id', def.winget_id!, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', (code) => {
      // winget exits 0 on success; non-zero codes are also used for "already installed" - treat both as ok=true
      if (code === 0 || code === -1978335189 /* ALREADY_INSTALLED */) resolve({ ok: true });
      else resolve({ ok: false, error: `winget exited ${code}` });
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}
