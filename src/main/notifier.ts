import { Notification } from 'electron';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { sendTelegramMessage, makeCallbackData, InlineButton } from './telegramBridge.js';
import { getSetting, hasSeenFinding, markFindingSeen } from './dataStore.js';
import { PCDOCTOR_ROOT } from './constants.js';
import type { Finding, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';

const BUFFER_FILE = path.join(PCDOCTOR_ROOT, 'notifications-buffer.json');

interface BufferedNotification {
  ts: number;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  eventKey: string;
}

function loadBuffer(): BufferedNotification[] {
  if (!existsSync(BUFFER_FILE)) return [];
  try { return JSON.parse(readFileSync(BUFFER_FILE, 'utf8')); }
  catch { return []; }
}

function saveBuffer(list: BufferedNotification[]): void {
  try { writeFileSync(BUFFER_FILE, JSON.stringify(list, null, 2), 'utf8'); }
  catch {}
}

export function getDigestHour(): number {
  const raw = getSetting('digest_hour');
  return raw !== null ? parseInt(raw, 10) : 8;  // default 8 AM
}

interface NotifyOptions {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  body: string;
  eventKey: string;
  suggested_action?: ActionName;
  finding_hash?: string;
}

function isQuietHours(): boolean {
  const start = parseInt(getSetting('quiet_hours_start') ?? '23', 10);
  const end = parseInt(getSetting('quiet_hours_end') ?? '7', 10);
  const now = new Date().getHours();
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

function toastEnabled(eventKey: string, severity: string): boolean {
  const raw = getSetting(`event:${eventKey}:toast`);
  if (raw === null) return severity === 'critical' || severity === 'warning';
  return raw === '1';
}

function telegramEnabled(eventKey: string, severity: string): boolean {
  if (getSetting('telegram_enabled') !== '1') return false;
  const raw = getSetting(`event:${eventKey}:telegram`);
  if (raw === null) return severity === 'critical';
  return raw === '1';
}

export async function notify(opts: NotifyOptions): Promise<void> {
  const quiet = isQuietHours();
  const allowToast = toastEnabled(opts.eventKey, opts.severity);
  const allowTelegram = telegramEnabled(opts.eventKey, opts.severity);
  const bypassQuiet = opts.severity === 'critical';

  // During quiet hours, buffer non-critical notifications instead of sending
  if (quiet && !bypassQuiet) {
    if (allowToast || allowTelegram) {
      const buf = loadBuffer();
      buf.push({
        ts: Date.now(),
        severity: opts.severity,
        title: opts.title,
        body: opts.body,
        eventKey: opts.eventKey,
      });
      // Cap buffer to 100
      while (buf.length > 100) buf.shift();
      saveBuffer(buf);
    }
    return;
  }

  if (allowToast && (!quiet || bypassQuiet)) {
    try {
      if (Notification.isSupported()) {
        new Notification({
          title: opts.title,
          body: opts.body,
          urgency: opts.severity === 'critical' ? 'critical' : 'normal',
        }).show();
      }
    } catch {}
  }

  if (allowTelegram && (!quiet || bypassQuiet)) {
    const sev = opts.severity === 'critical' ? '🔴' : opts.severity === 'warning' ? '⚠️' : 'ℹ️';
    const text = `${sev} <b>${escape(opts.title)}</b>\n\n${escape(opts.body)}\n\n<i>PCDoctor · ${new Date().toLocaleString()}</i>`;

    const buttons: InlineButton[][] = [];
    if (opts.suggested_action && opts.finding_hash && ACTIONS[opts.suggested_action]) {
      const actDef = ACTIONS[opts.suggested_action];
      buttons.push([
        { text: `${actDef.icon} ${actDef.label}`, callback_data: makeCallbackData('act', opts.suggested_action, opts.finding_hash) },
        { text: '✖ Dismiss', callback_data: makeCallbackData('dismiss', opts.finding_hash) },
      ]);
    }

    await sendTelegramMessage(text, buttons.length > 0 ? buttons : undefined);
  }
}

function escape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function hashFinding(f: Finding): string {
  return createHash('sha256').update(`${f.severity}|${f.area}|${f.message}`).digest('hex').slice(0, 16);
}

export async function flushBufferedNotifications(): Promise<{ sent: number }> {
  const buf = loadBuffer();
  if (buf.length === 0) return { sent: 0 };

  const critical = buf.filter(b => b.severity === 'critical');
  const warnings = buf.filter(b => b.severity === 'warning');
  const infos = buf.filter(b => b.severity === 'info');

  const summary = `📬 <b>PCDoctor overnight digest</b>\n\n` +
    `During quiet hours: <b>${critical.length}</b> critical · <b>${warnings.length}</b> warnings · <b>${infos.length}</b> info\n\n` +
    buf.slice(0, 20).map(b => {
      const sev = b.severity === 'critical' ? '🔴' : b.severity === 'warning' ? '⚠️' : 'ℹ️';
      const time = new Date(b.ts).toLocaleTimeString();
      return `${sev} [${time}] <b>${escape(b.title)}</b>\n   ${escape(b.body).slice(0, 150)}`;
    }).join('\n\n') +
    (buf.length > 20 ? `\n\n…and ${buf.length - 20} more` : '');

  // Send via Telegram (if configured). We bypass the notifier to avoid double-buffering.
  if (getSetting('telegram_enabled') === '1') {
    const { sendTelegramMessage } = await import('./telegramBridge.js');
    await sendTelegramMessage(summary);
  }

  // Clear buffer
  saveBuffer([]);
  return { sent: buf.length };
}

export async function emitNewFindingNotifications(findings: Finding[]): Promise<void> {
  for (const f of findings) {
    if (f.severity !== 'critical' && f.severity !== 'warning') continue;
    const h = hashFinding(f);
    if (hasSeenFinding(h)) continue;
    markFindingSeen(h, true);
    const eventKey = f.severity === 'critical' ? 'critical_finding' : 'warning_finding';
    await notify({
      severity: f.severity,
      title: `${f.severity === 'critical' ? 'Critical' : 'Warning'}: ${f.area}`,
      body: f.message,
      eventKey,
      suggested_action: f.suggested_action,
      finding_hash: h,
    });
  }
}
