import { watch, existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { PCDOCTOR_ROOT } from './constants.js';
import { runAction } from './actionRunner.js';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';

const MAX_PARAMS_BYTES = 1024;

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

  const watcher = watch(BRIDGE_DIR, async (eventType, filename) => {
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
          // Schema validation: reject unknown actions and oversized params
          if (!cmd || typeof cmd.id !== 'string' || typeof cmd.action !== 'string') {
            console.warn('claude-bridge: rejected command with missing id/action');
            continue;
          }
          // Reviewer P1: cmd.id is used as part of the IPC channel
          // 'claude-approval-response-${id}'. Constrain it to a safe charset
          // so a malicious bridge file can't craft a channel colliding with
          // another app IPC route.
          if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cmd.id)) {
            console.warn(`claude-bridge: rejected command with invalid id shape '${cmd.id}'`);
            continue;
          }
          if (!(cmd.action in ACTIONS)) {
            console.warn(`claude-bridge: rejected unknown action '${cmd.action}'`);
            appendFileSync(RESPONSES_FILE, JSON.stringify({ id: cmd.id, status: 'rejected', reason: 'Unknown action' }) + '\n');
            continue;
          }
          if (cmd.params && Buffer.byteLength(JSON.stringify(cmd.params), 'utf8') > MAX_PARAMS_BYTES) {
            console.warn(`claude-bridge: rejected command '${cmd.id}' - params exceed ${MAX_PARAMS_BYTES} bytes`);
            appendFileSync(RESPONSES_FILE, JSON.stringify({ id: cmd.id, status: 'rejected', reason: 'Params too large' }) + '\n');
            continue;
          }
          await handleClaudeCommand(cmd, getWindow());
        } catch (e) {
          console.warn('claude-bridge: dropped malformed JSONL line', e);
        }
      }
    } catch (e) {
      console.warn('claude-bridge: read error', e);
    }
  });
  watcher.on('error', (err) => {
    console.error('claude-bridge watcher error', err);
  });
}

async function handleClaudeCommand(cmd: ClaudeCommand, win: BrowserWindow | null): Promise<void> {
  if (!win) {
    appendFileSync(RESPONSES_FILE, JSON.stringify({ id: cmd.id, status: 'rejected', reason: 'Workbench window not available' }) + '\n');
    return;
  }

  // Ask the renderer to show an approval modal.
  // Reviewer P2: guard against the race where the user clicks Approve just
  // as the 90s timer fires (previously the decision could be dropped).
  const approved = await new Promise<boolean>((resolve) => {
    const channel = `claude-approval-response-${cmd.id}`;
    const { ipcMain } = require('electron');
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      ipcMain.removeListener(channel, handler);
    };
    const handler = (_evt: any, decision: boolean) => {
      if (settled) return;
      cleanup();
      resolve(decision);
    };
    ipcMain.once(channel, handler);
    win.webContents.send('claude-approval-request', { id: cmd.id, action: cmd.action, params: cmd.params, context: cmd.context });
    timer = setTimeout(() => {
      if (settled) return;
      cleanup();
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
