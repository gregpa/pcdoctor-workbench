/**
 * Export a comprehensive diagnostic snapshot in Markdown format that can be
 * pasted directly into Claude Code, claude.ai, or another AI for review.
 *
 * Runs inside Electron's main process so it has access to the same
 * better-sqlite3 binary the app uses (avoids the NODE_MODULE_VERSION mismatch
 * that external `node` scripts hit).
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { listActionLog, type ActionLogRow } from './dataStore.js';
import { PCDOCTOR_ROOT, LATEST_JSON_PATH } from './constants.js';

export interface ClaudeReport {
  markdown: string;
  line_count: number;
  byte_count: number;
  file_path: string;
  generated_at: number;
}

// v2.3.0 B3 fix #3: include the 11 Autopilot tasks so the Claude export
// reflects all tasks Workbench manages.
const MANAGED_TASKS = [
  'PCDoctor-Workbench-Autostart', 'PCDoctor-Daily-Quick', 'PCDoctor-Weekly',
  'PCDoctor-Weekly-Review', 'PCDoctor-Forecast', 'PCDoctor-Security-Daily',
  'PCDoctor-Security-Weekly', 'PCDoctor-Prune-Rollbacks', 'PCDoctor-Monthly-Deep',
  // Autopilot (v2.2.0) — registered by Register-All-Tasks.ps1
  'PCDoctor-Autopilot-SmartCheck',
  'PCDoctor-Autopilot-DefenderQuickScan',
  'PCDoctor-Autopilot-UpdateDefenderDefs',
  'PCDoctor-Autopilot-EmptyRecycleBins',
  'PCDoctor-Autopilot-ClearBrowserCaches',
  'PCDoctor-Autopilot-MalwarebytesCli',
  'PCDoctor-Autopilot-AdwCleanerScan',
  'PCDoctor-Autopilot-SafetyScanner',
  'PCDoctor-Autopilot-HwinfoLog',
  'PCDoctor-Autopilot-UpdateHostsStevenBlack',
  'PCDoctor-Autopilot-ShrinkComponentStore',
];

function truncate(s: string, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max) + '...[truncated]';
}

/**
 * v2.3.0 B3 fix #2: PowerShell writes latest.json with a UTF-8 BOM.
 * JSON.parse can't handle the leading 0xFEFF, so we'd silently return null
 * and the export would render "(latest.json not found or unreadable)" while
 * the file was fine. Strip the BOM before parsing.
 */
function safeReadJson(p: string): any {
  try {
    let raw = readFileSync(p, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectEventLog(): string[] {
  // Windows-only. Use wevtutil so we avoid pulling in PS for a one-shot query.
  try {
    const r = spawnSync('wevtutil', [
      'qe', 'Application',
      '/q:*[System[Provider[@Name="PCDoctor"]]]',
      '/c:30', '/rd:true', '/f:text',
    ], { encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    if (r.status !== 0) return [`(wevtutil exit ${r.status}: ${r.stderr?.slice(0,200)})`];
    // Split on record boundaries
    return (r.stdout || '').split(/^Event\[/gm).filter(Boolean).slice(0, 30);
  } catch (e: any) {
    return [`(event log read failed: ${e.message})`];
  }
}

function collectScheduledTasks(): Array<{ name: string; state: string; lastRun: string; lastResult: string; nextRun: string }> {
  const out: Array<{ name: string; state: string; lastRun: string; lastResult: string; nextRun: string }> = [];
  for (const name of MANAGED_TASKS) {
    try {
      // schtasks.exe hangs when invoked directly from Node child_process
      // (regardless of stdio config). Wrap in powershell.exe so it gets a
      // proper console attachment.
      const r = spawnSync('powershell.exe', [
        '-NoProfile', '-NonInteractive',
        '-Command', `schtasks /Query /TN "${name}" /FO CSV /V`,
      ], {
        encoding: 'utf8', timeout: 5_000, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (r.status !== 0) {
        // v2.3.0 B3 fix #3: log stderr so permission/missing-task failures are
        // diagnosable from the exported report instead of showing "-" with no
        // context.
        const stderr = (r.stderr ?? '').trim().slice(0, 160);
        const state = stderr ? `NOT REGISTERED (${stderr})` : 'NOT REGISTERED';
        out.push({ name, state, lastRun: '-', lastResult: '-', nextRun: '-' });
        continue;
      }
      const lines = (r.stdout || '').split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) { out.push({ name, state: '?', lastRun: '-', lastResult: '-', nextRun: '-' }); continue; }
      // CSV headers = line[0], data = line[1]
      const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, ''));
      const vals    = lines[1].split(',').map(v => v.replace(/^"|"$/g, ''));
      const get = (key: string) => { const i = headers.indexOf(key); return i >= 0 ? vals[i] : ''; };
      out.push({
        name,
        state: get('Status') || get('Scheduled Task State'),
        lastRun: get('Last Run Time'),
        lastResult: get('Last Result'),
        nextRun: get('Next Run Time'),
      });
    } catch {
      out.push({ name, state: 'ERROR', lastRun: '-', lastResult: '-', nextRun: '-' });
    }
  }
  return out;
}

function collectSystemInfo(): Record<string, string> {
  const info: Record<string, string> = {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} ${os.arch()}`,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? '?',
    chromeVersion: process.versions.chrome ?? '?',
    uptimeHours: (os.uptime() / 3600).toFixed(1),
    totalMemGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
    freeMemGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(1),
    cpus: `${os.cpus().length}x ${os.cpus()[0]?.model ?? 'unknown'}`,
  };
  return info;
}

/**
 * v2.3.0 B3 fix #1: newer audit rows store `ts` in milliseconds (Date.now()),
 * older rows stored it in seconds. Multiplying a ms value by 1000 yielded year
 * 58268 in the export. Detect the unit heuristically (anything > 1e12 is ms).
 */
function toIsoTs(ts: number): string {
  const ms = ts > 1e12 ? ts : ts * 1000;
  return new Date(ms).toISOString();
}

function formatActionRow(row: ActionLogRow): string {
  const when = toIsoTs(row.ts).replace('T', ' ').slice(0, 19);
  const status = row.status === 'success' ? 'OK' : row.status === 'error' ? 'FAIL' : row.status.toUpperCase();
  const dur = row.duration_ms != null ? `${row.duration_ms}ms` : '-';
  const errMsg = row.error_message ? truncate(row.error_message.replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), 200) : '';
  return `| ${row.id} | ${when} | ${row.action_name} | ${status} | ${dur} | ${errMsg} |`;
}

function formatActionDetails(rows: ActionLogRow[]): string {
  const failed = rows.filter(r => r.status === 'error');
  if (failed.length === 0) return '(no failed actions in recent history)';
  const parts: string[] = [];
  for (const r of failed.slice(0, 10)) {
    const when = toIsoTs(r.ts).replace('T', ' ').slice(0, 19);
    parts.push(`### Action #${r.id}: ${r.action_name} (${when})`);
    parts.push(`- Duration: ${r.duration_ms ?? '-'}ms`);
    parts.push(`- Triggered by: ${r.triggered_by}`);
    if (r.params_json) parts.push(`- Params: \`${truncate(r.params_json, 300)}\``);
    parts.push(`- **Error:**`);
    parts.push('```');
    parts.push(truncate(r.error_message ?? '(no error_message captured)', 3000));
    parts.push('```');
    if (r.result_json) {
      parts.push('- Result JSON:');
      parts.push('```json');
      parts.push(truncate(r.result_json, 1500));
      parts.push('```');
    }
    parts.push('');
  }
  return parts.join('\n');
}

export function buildClaudeReport(): ClaudeReport {
  const lines: string[] = [];
  const now = Math.floor(Date.now() / 1000);
  const iso = new Date(now * 1000).toISOString();

  lines.push('# PCDoctor Workbench - Diagnostic Snapshot for Claude Review');
  lines.push('');
  lines.push(`Generated: ${iso}`);
  lines.push(`Host: ${os.hostname()}`);
  lines.push('');
  lines.push('**Purpose:** This is a complete state dump of a running PCDoctor Workbench install. Please review for:');
  lines.push('- Failed actions and their root causes');
  lines.push('- Critical or warning findings and suggested remediation');
  lines.push('- Scheduled task health');
  lines.push('- Any stability/BSOD signal');
  lines.push('- Any regressions since last review');
  lines.push('');

  // 1. System info
  lines.push('## 1. System');
  const sys = collectSystemInfo();
  for (const [k, v] of Object.entries(sys)) lines.push(`- **${k}**: ${v}`);
  lines.push('');

  // 2. Current findings
  lines.push('## 2. Current Scan Findings');
  const latest = safeReadJson(LATEST_JSON_PATH);
  if (latest) {
    lines.push(`Scan time: \`${latest.timestamp ?? '?'}\``);
    const sum = latest.summary ?? {};
    lines.push(`Overall: **${sum.overall ?? '?'}** - Critical ${sum.critical ?? 0}, Warning ${sum.warning ?? 0}, Info ${sum.info ?? 0}`);
    lines.push('');
    if (Array.isArray(latest.findings) && latest.findings.length > 0) {
      lines.push('| Severity | Area | Message | Suggested Action | Detail |');
      lines.push('|---|---|---|---|---|');
      for (const f of latest.findings) {
        const msg = truncate(String(f.message ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' '), 300);
        const act = f.suggested_action ?? '';
        const det = f.detail ? truncate(JSON.stringify(f.detail).replace(/\|/g, '\\|'), 200) : '';
        lines.push(`| ${f.severity} | ${f.area} | ${msg} | ${act} | ${det} |`);
      }
    } else {
      lines.push('(no findings)');
    }
  } else {
    lines.push('(latest.json not found or unreadable)');
  }
  lines.push('');

  // 3. Action audit log - summary table
  lines.push('## 3. Recent Action Runs (last 50)');
  let audit: ActionLogRow[] = [];
  try { audit = listActionLog(50); } catch (e: any) {
    lines.push(`(audit log read failed: ${e.message})`);
  }
  if (audit.length > 0) {
    const okCount = audit.filter(r => r.status === 'success').length;
    const failCount = audit.filter(r => r.status === 'error').length;
    lines.push(`**Summary: ${okCount} OK, ${failCount} FAILED, ${audit.length} total**`);
    lines.push('');
    lines.push('| ID | When (UTC) | Action | Status | Duration | Error |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of audit) lines.push(formatActionRow(r));
  } else {
    lines.push('(no action history)');
  }
  lines.push('');

  // 4. Failed action details - full error output
  lines.push('## 4. Failed Action Details (full error output)');
  lines.push(formatActionDetails(audit));
  lines.push('');

  // 5. Scheduled tasks
  lines.push('## 5. Scheduled Tasks');
  lines.push('| Task | State | Last Run | Last Result | Next Run |');
  lines.push('|---|---|---|---|---|');
  for (const t of collectScheduledTasks()) {
    lines.push(`| ${t.name} | ${t.state} | ${t.lastRun} | ${t.lastResult} | ${t.nextRun} |`);
  }
  lines.push('');

  // 6. Event log
  lines.push('## 6. Recent PCDoctor Event Log (last 30)');
  lines.push('```');
  const events = collectEventLog();
  lines.push(events.slice(0, 20).map(e => e.slice(0, 600)).join('\n---\n'));
  lines.push('```');
  lines.push('');

  // 7. Report file listing
  lines.push('## 7. Recent Scan Reports on Disk');
  try {
    const reportsDir = path.join(PCDOCTOR_ROOT, 'reports');
    if (existsSync(reportsDir)) {
      const { readdirSync, statSync } = require('node:fs');
      const dirs = (readdirSync(reportsDir) as string[])
        .filter(n => /^\d{8}-\d{6}$/.test(n))
        .sort().reverse().slice(0, 10);
      lines.push(`Directory: \`${reportsDir}\``);
      for (const d of dirs) {
        const full = path.join(reportsDir, d);
        const s = statSync(full);
        lines.push(`- ${d} (${s.mtime.toISOString().slice(0,16)})`);
      }
    }
  } catch (e: any) {
    lines.push(`(reports dir read failed: ${e.message})`);
  }
  lines.push('');

  // 8. Workbench version
  lines.push('## 8. Workbench Install');
  try {
    const pkgPath = path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'package.json');
    const altPath = path.join(__dirname, '..', '..', 'package.json');
    const pkg = safeReadJson(pkgPath) ?? safeReadJson(altPath);
    if (pkg) lines.push(`- Version: **${pkg.version}** (name: ${pkg.name})`);
  } catch { /* best effort */ }
  lines.push(`- Electron: ${process.versions.electron}`);
  lines.push(`- Node (embedded): ${process.versions.node}`);
  lines.push('');

  lines.push('---');
  lines.push('**End of report.** Paste the section you want reviewed, or the whole thing for a full audit.');

  const markdown = lines.join('\n');

  // Persist to file so user can attach via drag-drop too
  const outDir = path.join(PCDOCTOR_ROOT, 'exports');
  try { mkdirSync(outDir, { recursive: true }); } catch { /* exists */ }
  const ts = new Date(now * 1000).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filePath = path.join(outDir, `claude-report-${ts}.md`);
  try { writeFileSync(filePath, markdown, 'utf8'); } catch { /* non-fatal */ }

  return {
    markdown,
    line_count: lines.length,
    byte_count: Buffer.byteLength(markdown, 'utf8'),
    file_path: filePath,
    generated_at: now,
  };
}
