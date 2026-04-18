import { Notification } from 'electron';
import { createHash } from 'node:crypto';
import { sendTelegramMessage, makeCallbackData, InlineButton } from './telegramBridge.js';
import { getSetting, hasSeenFinding, markFindingSeen } from './dataStore.js';
import type { Finding, ActionName } from '@shared/types.js';
import { ACTIONS } from '@shared/actions.js';

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
