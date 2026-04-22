import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import https from 'node:https';
import { URL } from 'node:url';
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
    // Avoid single-quote injection: pass the package name as a separate -Command param arg
    const pkgName = packageFamily.split('_')[0].replace(/'/g, '');
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      `if (Get-AppxPackage -Name '${pkgName}' -ErrorAction SilentlyContinue) { 'yes' }`,
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

  // v2.4.32: the v2.3.x "winget run" fallback here has never worked -
  // 'winget run' isn't a real subcommand, so spawn succeeds (the winget
  // binary exists) but the process dies immediately with exit 1 which
  // we never saw because we returned ok=true without waiting. Result:
  // users clicked Launch, saw a success toast, and nothing opened.
  // Instead: if detection finds the tool installed-via-winget but not
  // at a known exe path, surface a clear error asking the user to
  // update detect_paths or launch from Start Menu. LHM is the first
  // tool to hit this because winget installs it per-user under
  // %LOCALAPPDATA%\Microsoft\WinGet\Packages\...; tools.ts now
  // includes that path in LHM's detect_paths so this branch isn't
  // taken for LHM any more. Other winget-only tools may trigger it;
  // the error text tells the user what to do.
  if (status.installed && !status.resolved_path && def.winget_id) {
    return {
      ok: false,
      error: `${def.name} is installed via winget but PCDoctor couldn't find its exe. Launch it from the Start Menu once; if the launch still fails after that, please file an issue so we can add the path to tools.ts.`,
    };
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

/**
 * Download def.download_url to def.detect_paths[0] via https.get.
 * - If the file already exists and is < maxAgeDays old, skip the download.
 * - Follows up to 5 redirects.
 * - Verifies the downloaded file exists and has non-zero size.
 */
export async function installToolViaDirectDownload(
  toolId: string,
  maxAgeDays = 10,
): Promise<{ ok: boolean; error?: string; path?: string; bytes?: number; cached?: boolean }> {
  const def = TOOLS[toolId];
  if (!def) return { ok: false, error: `Unknown tool: ${toolId}` };
  if (!def.download_url) return { ok: false, error: 'No download_url configured for this tool' };
  const destPath = def.detect_paths[0];
  if (!destPath) return { ok: false, error: 'No detect_paths[0] defined for direct-download target' };

  const resolvedDest = destPath.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);

  // Cache hit: return immediately if file exists and is fresh enough.
  try {
    if (existsSync(resolvedDest)) {
      const st = statSync(resolvedDest);
      if (st.size > 0) {
        const ageDays = (Date.now() - st.mtimeMs) / (24 * 60 * 60 * 1000);
        if (ageDays < maxAgeDays) {
          return { ok: true, path: resolvedDest, bytes: st.size, cached: true };
        }
      }
    }
  } catch { /* fall through to re-download */ }

  // Ensure parent dir exists.
  try {
    const parent = path.dirname(resolvedDest);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  } catch (e: any) {
    return { ok: false, error: `Failed to create target directory: ${e?.message ?? e}` };
  }

  try {
    await httpsDownload(def.download_url, resolvedDest);
  } catch (e: any) {
    // Best-effort cleanup of partial file
    try { if (existsSync(resolvedDest)) unlinkSync(resolvedDest); } catch {}
    return { ok: false, error: `Download failed: ${e?.message ?? e}` };
  }

  try {
    const st = statSync(resolvedDest);
    if (st.size === 0) {
      try { unlinkSync(resolvedDest); } catch {}
      return { ok: false, error: 'Downloaded file has zero bytes' };
    }
    return { ok: true, path: resolvedDest, bytes: st.size, cached: false };
  } catch (e: any) {
    return { ok: false, error: `Downloaded file verification failed: ${e?.message ?? e}` };
  }
}

function httpsDownload(url: string, destPath: string, redirectsRemaining = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      reject(new Error(`Refusing to download over non-HTTPS protocol: ${parsed.protocol}`));
      return;
    }
    const req = https.get(url, { timeout: 120_000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsRemaining <= 0) {
          reject(new Error('Too many redirects'));
          return;
        }
        // Resolve relative redirect targets against the current URL
        const next = new URL(res.headers.location, url).toString();
        res.resume();
        httpsDownload(next, destPath, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} ${res.statusMessage ?? ''}`));
        res.resume();
        return;
      }
      const ws = createWriteStream(destPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(() => resolve()));
      ws.on('error', (e) => reject(e));
      res.on('error', (e) => reject(e));
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', (e) => reject(e));
  });
}
