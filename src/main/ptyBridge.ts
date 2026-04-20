import { ipcMain, BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { PCDOCTOR_ROOT, LATEST_JSON_PATH } from './constants.js';
import { resolveClaudePath } from './claudeBridge.js';

let ptyModule: any = null;
let ptyAvailable = false;
let ptyLoadError: string | null = null;

// Try to load node-pty - swallow any native-module load error.
// This runs once on first IPC call, not at module import time.
async function ensurePtyLoaded(): Promise<boolean> {
  if (ptyAvailable) return true;
  if (ptyModule === null && ptyLoadError === null) {
    try {
      // Use variable to defeat TS module resolution - node-pty is optional.
      const mod = 'node-pty';
      ptyModule = await import(/* @vite-ignore */ mod);
      ptyAvailable = true;
      return true;
    } catch (e: any) {
      ptyLoadError = e?.message ?? 'node-pty failed to load';
      ptyModule = null;
      return false;
    }
  }
  return ptyAvailable;
}

interface ActiveSession {
  id: string;
  proc: any;   // pty.IPty but avoid type import since node-pty may not be loadable
}

const sessions = new Map<string, ActiveSession>();

// Reviewer P1: validate channel-bearing ids from the renderer. If the
// renderer is compromised (e.g. via a future malicious dep), a crafted id
// could collide with other app IPC channels. 1-64 chars of safe charset.
const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
function assertValidChannelId(id: unknown): string {
  if (typeof id !== 'string' || !CHANNEL_ID_RE.test(id)) {
    throw new Error(`Invalid channel id; expected /^[a-zA-Z0-9_-]{1,64}$/`);
  }
  return id;
}

async function buildContextFile(contextText?: string): Promise<string> {
  const sessionDir = path.join(os.tmpdir(), `pcdoctor-claude-pty-${Date.now()}`);
  await mkdir(sessionDir, { recursive: true });
  let latest = 'unavailable';
  try {
    latest = await readFile(LATEST_JSON_PATH, 'utf8');
    if (latest.charCodeAt(0) === 0xFEFF) latest = latest.slice(1);
  } catch {}
  const ctx = `# PCDoctor Workbench - Claude session context

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
  ipcMain.handle('api:claudePty:available', async (): Promise<{ available: boolean; error?: string }> => {
    const ok = await ensurePtyLoaded();
    return { available: ok, error: ptyLoadError ?? undefined };
  });

  ipcMain.handle('api:claudePty:spawn', async (_evt, opts: { id: string; contextText?: string; cols?: number; rows?: number }): Promise<{ ok: boolean; error?: string }> => {
    let id: string;
    try { id = assertValidChannelId(opts?.id); } catch (e: any) { return { ok: false, error: e?.message ?? 'Invalid id' }; }
    const { contextText, cols, rows } = opts;
    if (sessions.has(id)) return { ok: false, error: 'Session already exists' };

    const ok = await ensurePtyLoaded();
    if (!ok || !ptyModule) {
      return { ok: false, error: `Embedded terminal unavailable. node-pty failed to load: ${ptyLoadError ?? 'unknown'}. Use the "External Window" mode instead.` };
    }

    const claudePath = resolveClaudePath();
    if (!claudePath) return { ok: false, error: 'Claude CLI not found on PATH' };

    try {
      const ctxPath = await buildContextFile(contextText);
      const shell = process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe';

      // Batch-file trampoline: passing the full quoted command as a /k arg
      // double-escapes on Windows (cmd + node-pty both quote) and cmd.exe
      // sees the whole path as a bogus token, producing:
      //   '"C:\...\claude.cmd"' is not recognized
      // Writing the command into a temp .bat and spawning `cmd /k <bat>`
      // avoids every layer of the quoting dance.
      const batPath = path.join(os.tmpdir(), `pcdoctor-claude-${Date.now()}-${id}.bat`);
      const batContents = [
        '@echo off',
        `call "${claudePath}" --add-dir "${PCDOCTOR_ROOT}"`,
        '',
      ].join('\r\n');
      await writeFile(batPath, batContents, 'utf8');

      const proc = ptyModule.spawn(shell, ['/k', batPath], {
        name: 'xterm-256color',
        cols: cols ?? 100,
        rows: rows ?? 28,
        cwd: PCDOCTOR_ROOT,
        env: {
          ...process.env,
          PCDOCTOR_CONTEXT: ctxPath,
        },
      });

      proc.onData((data: string) => {
        const win = getWindow();
        if (win) win.webContents.send(`claudePty:data:${id}`, data);
      });

      proc.onExit(({ exitCode }: { exitCode: number }) => {
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
    try { s.proc.write(opts.data); } catch {}
    return { ok: true };
  });

  ipcMain.handle('api:claudePty:resize', async (_evt, opts: { id: string; cols: number; rows: number }): Promise<{ ok: boolean }> => {
    const s = sessions.get(opts.id);
    if (!s) return { ok: false };
    try { s.proc.resize(opts.cols, opts.rows); } catch {}
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
