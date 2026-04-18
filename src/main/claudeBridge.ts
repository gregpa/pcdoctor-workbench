import { spawn } from 'node:child_process';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LATEST_JSON_PATH } from './constants.js';

/** Detect the `claude` binary path. */
export function resolveClaudePath(): string | null {
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'npm', 'claude.cmd'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'claude.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Glob for versioned Claude install
  const claudeRoot = path.join(process.env.APPDATA ?? '', 'Claude', 'claude-code');
  if (existsSync(claudeRoot)) {
    try {
      const { readdirSync } = require('node:fs');
      const versions = readdirSync(claudeRoot).sort().reverse();
      if (versions.length > 0) {
        const candidate = path.join(claudeRoot, versions[0], 'claude.exe');
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

/** Compose the context file that Claude will load via --append-system-prompt. */
async function buildContextFile(): Promise<string> {
  const sessionDir = path.join(os.tmpdir(), `pcdoctor-claude-${Date.now()}`);
  await mkdir(sessionDir, { recursive: true });
  let latestJson = 'unavailable';
  try {
    latestJson = await readFile(LATEST_JSON_PATH, 'utf8');
    if (latestJson.charCodeAt(0) === 0xFEFF) latestJson = latestJson.slice(1);
  } catch {}

  const ctx = `# PCDoctor Workbench session context

You are helping diagnose and maintain this Windows PC via PCDoctor Workbench.

## Workspace paths
- PCDoctor scripts: C:\\ProgramData\\PCDoctor\\
- Dashboard diagnostic JSON: ${LATEST_JSON_PATH}
- SQLite DB: C:\\ProgramData\\PCDoctor\\workbench.db
- The pc-doctor skill lives at ~/.claude/skills/pc-doctor/

## Current latest.json
\`\`\`json
${latestJson.slice(0, 20000)}
\`\`\`

When the user asks about system state, check the JSON above first, then use Read/Grep on the PCDoctor files as needed.
`;
  const ctxPath = path.join(sessionDir, 'context.md');
  await writeFile(ctxPath, ctx, 'utf8');
  return ctxPath;
}

export async function launchClaudeWithContext(contextText: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const claudePath = resolveClaudePath();
  if (!claudePath) {
    return { ok: false, error: 'Claude CLI not found' };
  }
  const sessionDir = path.join(os.tmpdir(), `pcdoctor-claude-${Date.now()}`);
  await mkdir(sessionDir, { recursive: true });
  let latestJson = 'unavailable';
  try {
    latestJson = await readFile(LATEST_JSON_PATH, 'utf8');
    if (latestJson.charCodeAt(0) === 0xFEFF) latestJson = latestJson.slice(1);
  } catch {}

  const ctx = `# PCDoctor Workbench — Investigation request

${contextText}

## Current latest.json
\`\`\`json
${latestJson.slice(0, 15000)}
\`\`\`

## Workspace paths
- PCDoctor scripts: C:\\ProgramData\\PCDoctor\\
- SQLite DB: C:\\ProgramData\\PCDoctor\\workbench.db
- Claude-bridge directory: C:\\ProgramData\\PCDoctor\\claude-bridge\\
  If the user approves an action you can request it by writing a JSON line to commands.jsonl:
  {"id":"cmd-123","action":"flush_dns","params":{}}
  Read responses.jsonl for results.
`;
  const ctxPath = path.join(sessionDir, 'context.md');
  await writeFile(ctxPath, ctx, 'utf8');

  const wtPath = 'C:\\Windows\\System32\\wt.exe';
  const useWt = existsSync(wtPath);

  try {
    if (useWt) {
      const cmd = `& '${claudePath}' --add-dir 'C:\\ProgramData\\PCDoctor'`;
      const child = spawn('wt.exe', [
        'new-tab',
        '--title', 'Claude (Investigate)',
        'pwsh.exe', '-NoExit', '-Command',
        `$env:PCDOCTOR_CONTEXT='${ctxPath}'; Write-Host 'Context pre-loaded at: $env:PCDOCTOR_CONTEXT' -ForegroundColor Yellow; Write-Host 'Type: Get-Content $env:PCDOCTOR_CONTEXT to see full context' -ForegroundColor Cyan; ${cmd}`,
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true, pid: child.pid };
    } else {
      const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `"${claudePath}" --add-dir "C:\\ProgramData\\PCDoctor"`], {
        detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.unref();
      return { ok: true, pid: child.pid };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Spawn failed' };
  }
}

export async function launchClaudeInTerminal(): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const claudePath = resolveClaudePath();
  if (!claudePath) {
    return { ok: false, error: 'Claude CLI not found. Install via npm install -g @anthropic-ai/claude-code' };
  }
  const ctxPath = await buildContextFile();

  // Build the command: wt.exe starts Windows Terminal; then run claude with context
  // Use wt if available; fall back to cmd.exe
  const wtPath = 'C:\\Windows\\System32\\wt.exe';
  const useWt = existsSync(wtPath) || existsSync('C:\\Users\\' + (process.env.USERNAME ?? 'user') + '\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe');

  try {
    if (useWt) {
      // wt.exe new-tab --title "Claude" pwsh -NoExit -Command "& 'claude' --add-dir '...' --append-system-prompt-file '...'"
      const cmd = `& '${claudePath}' --add-dir 'C:\\ProgramData\\PCDoctor'`;
      const child = spawn('wt.exe', [
        'new-tab',
        '--title', 'Claude (PCDoctor)',
        'pwsh.exe', '-NoExit', '-Command',
        `$env:PCDOCTOR_CONTEXT='${ctxPath}'; ${cmd}`,
      ], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return { ok: true, pid: child.pid };
    } else {
      // Fallback: plain cmd window
      const child = spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe', '/k', `"${claudePath}" --add-dir "C:\\ProgramData\\PCDoctor"`], {
        detached: true, stdio: 'ignore', windowsHide: false,
      });
      child.unref();
      return { ok: true, pid: child.pid };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Failed to spawn terminal' };
  }
}
