import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { ToolStatus } from '@shared/types.js';
import { TOOLS } from '@shared/tools.js';

function expandEnvVars(p: string): string {
  return p.replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`);
}

export function getToolStatus(toolId: string): ToolStatus {
  const def = TOOLS[toolId];
  if (!def) return { id: toolId, installed: false, resolved_path: null };
  for (const candidate of def.detect_paths) {
    const resolved = expandEnvVars(candidate);
    if (existsSync(resolved)) return { id: toolId, installed: true, resolved_path: resolved };
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
    const child = spawn('winget', ['install', '--id', def.winget_id!, '--silent', '--accept-package-agreements', '--accept-source-agreements'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `winget exited ${code}` });
    });
    child.on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}
