import { watch, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PCDOCTOR_ROOT } from './constants.js';
import { runAction } from './actionRunner.js';
import type { ActionName } from '@shared/types.js';

const BRIDGE_DIR = path.join(PCDOCTOR_ROOT, 'claude-bridge');
const COMMANDS_FILE = path.join(BRIDGE_DIR, 'commands.jsonl');
const RESPONSES_FILE = path.join(BRIDGE_DIR, 'responses.jsonl');

function ensureBridgeDir(): void {
  if (!existsSync(BRIDGE_DIR)) mkdirSync(BRIDGE_DIR, { recursive: true });
  if (!existsSync(COMMANDS_FILE)) writeFileSync(COMMANDS_FILE, '', 'utf8');
  if (!existsSync(RESPONSES_FILE)) writeFileSync(RESPONSES_FILE, '', 'utf8');
}

interface ClaudeCommand {
  id: string;
  action: ActionName;
  params?: Record<string, string | number>;
  context?: string;
}

let lastProcessedLine = 0;

export function startClaudeBridgeWatcher(getWindow: () => BrowserWindow | null): void {
  ensureBridgeDir();

  // Initialize to current file size so we don't replay old commands
  try {
    const current = readFileSync(COMMANDS_FILE, 'utf8');
    lastProcessedLine = current.split('\n').filter(l => l.trim()).length;
  } catch { lastProcessedLine = 0; }

  watch(BRIDGE_DIR, async (eventType, filename) => {
    if (filename !== 'commands.jsonl') return;
    if (!existsSync(COMMANDS_FILE)) return;
    try {
      const content = readFileSync(COMMANDS_FILE, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const newLines = lines.slice(lastProcessedLine);
      lastProcessedLine = lines.length;
      for (const line of newLines) {
        try {
          const cmd = JSON.parse(line) as ClaudeCommand;
          await handleClaudeCommand(cmd, getWindow());
        } catch {
          // malformed line
        }
      }
    } catch {}
  });
}

async function handleClaudeCommand(cmd: ClaudeCommand, win: BrowserWindow | null): Promise<void> {
  if (!win) {
    appendFileSync(RESPONSES_FILE, JSON.stringify({ id: cmd.id, status: 'rejected', reason: 'Workbench window not available' }) + '\n');
    return;
  }

  // Ask the renderer to show an approval modal
  const approved = await new Promise<boolean>((resolve) => {
    const channel = `claude-approval-response-${cmd.id}`;
    const { ipcMain } = require('electron');
    const handler = (_evt: any, decision: boolean) => {
      ipcMain.removeListener(channel, handler);
      resolve(decision);
    };
    ipcMain.once(channel, handler);
    win.webContents.send('claude-approval-request', { id: cmd.id, action: cmd.action, params: cmd.params, context: cmd.context });
    // Timeout after 90s
    setTimeout(() => {
      ipcMain.removeListener(channel, handler);
      resolve(false);
    }, 90_000);
  });

  if (!approved) {
    appendFileSync(RESPONSES_FILE, JSON.stringify({ id: cmd.id, status: 'rejected', reason: 'User declined' }) + '\n');
    return;
  }

  const result = await runAction({ name: cmd.action, params: cmd.params, triggered_by: 'alert' });
  appendFileSync(RESPONSES_FILE, JSON.stringify({
    id: cmd.id,
    status: result.success ? 'success' : 'error',
    duration_ms: result.duration_ms,
    result: result.result,
    error: result.error?.message,
  }) + '\n');
}
