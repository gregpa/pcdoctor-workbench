import { ipcMain, BrowserWindow } from 'electron';
import * as pty from 'node-pty';
import path from 'node:path';
import os from 'node:os';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { PCDOCTOR_ROOT, LATEST_JSON_PATH } from './constants.js';
import { resolveClaudePath } from './claudeBridge.js';

interface ActiveSession {
  id: string;
  proc: pty.IPty;
}

const sessions = new Map<string, ActiveSession>();

async function buildContextFile(contextText?: string): Promise<string> {
  const sessionDir = path.join(os.tmpdir(), `pcdoctor-claude-pty-${Date.now()}`);
  await mkdir(sessionDir, { recursive: true });
  let latest = 'unavailable';
  try {
    latest = await readFile(LATEST_JSON_PATH, 'utf8');
    if (latest.charCodeAt(0) === 0xFEFF) latest = latest.slice(1);
  } catch {}
  const ctx = `# PCDoctor Workbench — Claude session context

${contextText ?? 'General diagnostic session. Use Read / Bash / Grep to investigate system state.'}

## Current latest.json
\`\`\`json
${latest.slice(0, 15000)}
\`\`\`

## Bridge
- Commands.jsonl at C:\\ProgramData\\PCDoctor\\claude-bridge\\commands.jsonl
- Responses.jsonl at C:\\ProgramData\\PCDoctor\\claude-bridge\\responses.jsonl
`;
  const ctxPath = path.join(sessionDir, 'context.md');
  await writeFile(ctxPath, ctx, 'utf8');
  return ctxPath;
}

export function registerPtyIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('api:claudePty:spawn', async (_evt, opts: { id: string; contextText?: string; cols?: number; rows?: number }): Promise<{ ok: boolean; error?: string }> => {
    const { id, contextText, cols, rows } = opts;
    if (sessions.has(id)) return { ok: false, error: 'Session already exists' };

    const claudePath = resolveClaudePath();
    if (!claudePath) return { ok: false, error: 'Claude CLI not found on PATH' };

    try {
      const ctxPath = await buildContextFile(contextText);
      const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';
      const proc = pty.spawn(shell, ['/k', `"${claudePath}" --add-dir "${PCDOCTOR_ROOT}"`], {
        name: 'xterm-256color',
        cols: cols ?? 100,
        rows: rows ?? 28,
        cwd: PCDOCTOR_ROOT,
        env: {
          ...process.env,
          PCDOCTOR_CONTEXT: ctxPath,
        },
      });

      proc.onData((data) => {
        const win = getWindow();
        if (win) win.webContents.send(`claudePty:data:${id}`, data);
      });

      proc.onExit(({ exitCode }) => {
        const win = getWindow();
        if (win) win.webContents.send(`claudePty:exit:${id}`, { exitCode });
        sessions.delete(id);
      });

      sessions.set(id, { id, proc });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Failed to spawn pty' };
    }
  });

  ipcMain.handle('api:claudePty:write', async (_evt, opts: { id: string; data: string }): Promise<{ ok: boolean }> => {
    const s = sessions.get(opts.id);
    if (!s) return { ok: false };
    s.proc.write(opts.data);
    return { ok: true };
  });

  ipcMain.handle('api:claudePty:resize', async (_evt, opts: { id: string; cols: number; rows: number }): Promise<{ ok: boolean }> => {
    const s = sessions.get(opts.id);
    if (!s) return { ok: false };
    s.proc.resize(opts.cols, opts.rows);
    return { ok: true };
  });

  ipcMain.handle('api:claudePty:kill', async (_evt, id: string): Promise<{ ok: boolean }> => {
    const s = sessions.get(id);
    if (!s) return { ok: false };
    try { s.proc.kill(); } catch {}
    sessions.delete(id);
    return { ok: true };
  });
}

export function killAllPtySessions(): void {
  for (const s of sessions.values()) {
    try { s.proc.kill(); } catch {}
  }
  sessions.clear();
}
