import https from 'node:https';
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

export async function sendTelegramMessage(text: string): Promise<{ ok: boolean; error?: string }> {
  const token = getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (!token || !chatId) return { ok: false, error: 'Telegram not configured' };
  const r = await tgRequest<unknown>(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
  recordNotification({ channel: 'telegram', severity: 'info', title: 'message', body: text.slice(0, 500), sent_ok: r.ok, error: r.description });
  return r.ok ? { ok: true } : { ok: false, error: r.description };
}

export async function testTelegramConnection(token: string, chatId: string): Promise<{ ok: boolean; error?: string; bot_username?: string }> {
  // getMe to verify token
  const me = await tgRequest<{ username: string }>(token, 'getMe', {});
  if (!me.ok) return { ok: false, error: me.description ?? 'getMe failed' };
  // Send test message
  const send = await tgRequest(token, 'sendMessage', { chat_id: chatId, text: '✅ PCDoctor Workbench connected. You will receive alerts here.' });
  if (!send.ok) return { ok: false, error: send.description ?? 'sendMessage failed' };
  return { ok: true, bot_username: me.result?.username };
}
