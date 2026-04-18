import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { getSetting } from './dataStore.js';

interface DigestPayload {
  subject: string;
  html: string;
  to: string;
}

function findGwsRunner(): string | null {
  const candidates = [
    path.join(os.homedir(), '.claude', 'scripts', 'gws-runner.js'),
  ];
  for (const c of candidates) {
    try { if (require('node:fs').existsSync(c)) return c; } catch {}
  }
  return null;
}

export async function sendEmailDigest(payload: DigestPayload): Promise<{ ok: boolean; error?: string }> {
  const runner = findGwsRunner();
  if (!runner) return { ok: false, error: 'gws-gmail runner not found at ~/.claude/scripts/gws-runner.js' };

  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'pcd-email-'));
  const bodyFile = path.join(tmpDir, 'body.html');
  writeFileSync(bodyFile, payload.html, 'utf8');

  return new Promise((resolve) => {
    // Try gws gmail send - actual CLI shape: gws gmail send --to ... --subject ... --html-file ...
    // If that fails, Node wrapper is invoked with node path.
    const child = spawn('node', [runner, 'gmail', 'send', '--to', payload.to, '--subject', payload.subject, '--html-file', bodyFile, '--json'], {
      env: { ...process.env, NODE_PATH: process.env.NODE_PATH ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => out += d.toString());
    child.stderr.on('data', (d) => err += d.toString());
    child.on('exit', (code) => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `gws-runner exited ${code}: ${err || out}`.slice(0, 400) });
    });
    child.on('error', (e) => {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      resolve({ ok: false, error: e.message });
    });
  });
}

/** Build + send a weekly digest email. Called by scheduled task or on demand. */
export async function sendWeeklyDigestEmail(): Promise<{ ok: boolean; error?: string }> {
  const recipient = getSetting('email_digest_recipient');
  if (!recipient) return { ok: false, error: 'Email digest recipient not configured in Settings' };

  // Compose digest from latest weekly review + recent findings + forecast
  const { readFileSync: rf, existsSync: ex, readdirSync: rd } = require('node:fs');
  const path2 = require('node:path');
  const weeklyDir = 'C:\\ProgramData\\PCDoctor\\reports\\weekly';
  let latestReview: any = null;
  if (ex(weeklyDir)) {
    try {
      const files = (rd(weeklyDir) as string[]).filter((f: string) => f.endsWith('.json')).sort().reverse();
      if (files.length > 0) {
        let raw = rf(path2.join(weeklyDir, files[0]), 'utf8') as string;
        if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
        latestReview = JSON.parse(raw);
      }
    } catch {}
  }

  const subject = `PCDoctor Weekly Digest - ${latestReview?.review_date ?? new Date().toISOString().slice(0, 10)}`;
  const html = `
<!doctype html>
<html><head><meta charset="utf-8"><title>${subject}</title>
<style>body{font-family:-apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;padding:24px;max-width:700px;margin:0 auto}
h1,h2,h3{color:#fff}.crit{color:#ef4444}.warn{color:#f59e0b}.good{color:#22c55e}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px;margin-bottom:12px}
ul{margin:6px 0}li{margin:3px 0;font-size:13px}</style></head><body>
<h1>🖥 PCDoctor Weekly Digest</h1>
<p>${escapeHtml(latestReview?.hostname ?? 'Unknown host')} · ${new Date().toLocaleString()}</p>
${latestReview ? `
<div class="card">
  <h2>Summary</h2>
  <p><strong>${escapeHtml(String(latestReview.summary.overall))}</strong> - ${latestReview.summary.critical_count} critical · ${latestReview.summary.warning_count} warnings · ${latestReview.summary.info_count} info</p>
</div>
<div class="card">
  <h2>Action Items (${latestReview.action_items.length})</h2>
  <ul>
    ${latestReview.action_items.slice(0, 10).map((i: any) => {
      const cls = i.priority === 'critical' ? 'crit' : i.priority === 'important' ? 'warn' : '';
      return `<li><span class="${cls}">[${i.priority}]</span> <strong>${escapeHtml(i.area)}</strong>: ${escapeHtml(i.message)}</li>`;
    }).join('')}
  </ul>
</div>
<div class="card">
  <h2>Headroom</h2>
  <ul>${Object.entries(latestReview.headroom ?? {}).map(([k, v]) => `<li><strong>${k.replace(/_/g, ' ')}:</strong> ${escapeHtml(String(v))}</li>`).join('')}</ul>
</div>
` : '<p>No weekly review available yet.</p>'}
<p style="color:#8b949e;font-size:11px;margin-top:24px">Sent by PCDoctor Workbench · Configure or disable in Settings → Email Digest</p>
</body></html>`;

  return await sendEmailDigest({ subject, html, to: recipient });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
