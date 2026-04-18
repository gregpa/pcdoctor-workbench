import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';
import { getSetting, recordNotification } from './dataStore.js';

interface TelegramResponse<T> { ok: boolean; result?: T; description?: string; }

function tgRequest<T>(token: string, method: string, params: Record<string, unknown>): Promise<TelegramResponse<T>> {
  return new Promise((resolve) => {
    const body = JSON.stringify(params);
    const req = https.request({
      host: 'api.telegram.org',
      path: `/bot${token}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data) as TelegramResponse<T>); }
        catch (e: any) { resolve({ ok: false, description: e?.message ?? 'parse error' }); }
      });
    });
    req.on('error', (e) => resolve({ ok: false, description: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, description: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

export interface InlineButton {
  text: string;
  callback_data: string;   // max 64 chars
}

export async function sendTelegramMessage(text: string, buttons?: InlineButton[][]): Promise<{ ok: boolean; error?: string; message_id?: number }> {
  const token = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (!token || !chatId) return { ok: false, error: 'Telegram not configured' };
  const params: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (buttons && buttons.length > 0) {
    params.reply_markup = { inline_keyboard: buttons };
  }
  const r = await tgRequest<{ message_id: number }>(token, 'sendMessage', params);
  recordNotification({ channel: 'telegram', severity: 'info', title: 'message', body: text.slice(0, 500), sent_ok: r.ok, error: r.description });
  return r.ok ? { ok: true, message_id: r.result?.message_id } : { ok: false, error: r.description };
}

export async function testTelegramConnection(token: string, chatId: string): Promise<{ ok: boolean; error?: string; bot_username?: string }> {
  const me = await tgRequest<{ username: string }>(token, 'getMe', {});
  if (!me.ok) return { ok: false, error: me.description ?? 'getMe failed' };
  const send = await tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ PCDoctor Workbench connected. You will receive alerts here.' });
  if (!send.ok) return { ok: false, error: send.description ?? 'sendMessage failed' };
  return { ok: true, bot_username: me.result?.username };
}

// ===== callback_query polling + handler =====

interface CallbackQuery {
  id: string;
  from: { id: number; username?: string };
  message?: { message_id: number; chat: { id: number } };
  data?: string;
}

interface TgUpdate {
  update_id: number;
  callback_query?: CallbackQuery;
}

/** Makes a compact callback_data token — Telegram limits it to 64 bytes. */
export function makeCallbackData(action: string, ...parts: string[]): string {
  const nonce = randomBytes(3).toString('hex');  // 6 chars
  const payload = [action, ...parts, nonce].join('|');
  if (payload.length > 63) {
    // Fall back to hashing: keep action prefix, hash remainder
    const h = createHash('sha1').update(payload).digest('hex').slice(0, 16);
    return `${action}|h:${h}|${nonce}`;
  }
  return payload;
}

let pollingInterval: NodeJS.Timeout | null = null;
let lastUpdateId = 0;
let handlerFn: ((q: CallbackQuery) => Promise<void>) | null = null;

export function startTelegramPolling(handler: (q: CallbackQuery) => Promise<void>): void {
  handlerFn = handler;
  if (pollingInterval) return;
  pollingInterval = setInterval(pollOnce, 30_000);
  // Fire once immediately in 2s so startup doesn't wait 30s
  setTimeout(pollOnce, 2000);
}

export function stopTelegramPolling(): void {
  if (pollingInterval) { clearInterval(pollingInterval); pollingInterval = null; }
}

async function pollOnce(): Promise<void> {
  const token = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (!token || !chatId || getSetting('telegram_enabled') !== '1') return;
  const r = await tgRequest<TgUpdate[]>(token, 'getUpdates', {
    offset: lastUpdateId + 1,
    timeout: 0,
    allowed_updates: ['callback_query'],
  });
  if (!r.ok || !r.result) return;
  for (const upd of r.result) {
    if (upd.update_id > lastUpdateId) lastUpdateId = upd.update_id;
    if (upd.callback_query && upd.callback_query.from.id.toString() === chatId && handlerFn) {
      try { await handlerFn(upd.callback_query); } catch {}
    }
  }
}

export async function answerCallbackQuery(queryId: string, text?: string): Promise<void> {
  const token = getSetting('telegram_bot_token');
  if (!token) return;
  await tgRequest(token, 'answerCallbackQuery', { callback_query_id: queryId, text: text ?? '' });
}

export async function editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
  const token = getSetting('telegram_bot_token');
  if (!token) return;
  await tgRequest(token, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
  });
}
