import { readFile, appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { LATEST_JSON_PATH } from './constants.js';
import { recordStatusSnapshot, getMetricWeekDelta } from './dataStore.js';
import { emitNewFindingNotifications } from './notifier.js';
import type { SystemStatus, KpiValue, GaugeValue, Severity, Finding, ActionName, ServiceHealth, SmartEntry, SystemMetrics, WslConfigMetric, MemoryPressureMetric, StartupItemMetric } from '@shared/types.js';

// v2.4.37: per-call timing telemetry for getStatus so we can diagnose the
// resize freeze on Greg's box empirically in v2.4.38. One JSON line per
// invocation, appended to C:\ProgramData\PCDoctor\logs\perf-YYYYMMDD.log.
// Fire-and-forget; log write failures are swallowed so they never block
// or break getStatus itself.
const PERF_LOG_DIR = 'C:\\ProgramData\\PCDoctor\\logs';
let _perfLogDirEnsured = false;

function perfLogPath(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return path.join(PERF_LOG_DIR, `perf-${y}${m}${day}.log`);
}

async function writePerfLine(phase: string, durationMs: number, extra?: Record<string, unknown>): Promise<void> {
  try {
    if (!_perfLogDirEnsured) {
      await mkdir(PERF_LOG_DIR, { recursive: true });
      _perfLogDirEnsured = true;
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      phase,
      duration_ms: Math.round(durationMs * 100) / 100,
      ...extra,
    }) + '\n';
    await appendFile(perfLogPath(), line, 'utf8');
  } catch { /* telemetry must never throw */ }
}

let cachedSmart: SmartEntry[] = [];
export function setCachedSmart(entries: SmartEntry[]) {
  cachedSmart = entries;
}

function computeDelta(current: number, weekAgo: number | null, badDirection: 'up' | 'down'): { direction: 'up' | 'down' | 'neutral'; text: string; severity: Severity } | undefined {
  if (weekAgo === null || !Number.isFinite(weekAgo)) return undefined;
  const diff = current - weekAgo;
  const abs = Math.abs(diff);
  if (abs < 1) return { direction: 'neutral', text: 'no change', severity: 'good' };
  const dir: 'up' | 'down' = diff > 0 ? 'up' : 'down';
  const isBad = dir === badDirection;
  const sev: Severity = isBad ? (abs > 10 ? 'crit' : 'warn') : 'good';
  return {
    direction: dir,
    text: `${diff > 0 ? '+' : ''}${diff.toFixed(1)} vs last week`,
    severity: sev,
  };
}

/** DB-safe lookup - returns nulls if the DB isn't available (e.g. in test env with mismatched native binding). */
function safeWeekDelta(category: string, metric: string, label?: string): { week_ago: number | null; now: number | null } {
  try { return getMetricWeekDelta(category, metric, label); }
  catch { return { week_ago: null, now: null }; }
}

// v2.4.30: cache the most recent temperature read for 30s so repeated
// getStatus calls (e.g. useStatus polling re-fires during window
// resize) don't stampede Get-Temperatures PS spawns. One PS spawn per
// 30s is plenty for trend resolution - CPU and GPU temps don't change
// meaningfully faster than that.
let _tempsCache: { ts: number; value: { cpu_temp_c?: number; gpu_temp_c?: number } | null } | null = null;
let _tempsInFlight: Promise<{ cpu_temp_c?: number; gpu_temp_c?: number } | null> | null = null;
const TEMPS_CACHE_MS = 30_000;

async function readTemperaturesCached(): Promise<{ cpu_temp_c?: number; gpu_temp_c?: number } | null> {
  const now = Date.now();
  if (_tempsCache && (now - _tempsCache.ts) < TEMPS_CACHE_MS) {
    return _tempsCache.value;
  }
  if (_tempsInFlight) return _tempsInFlight;
  _tempsInFlight = readTemperaturesBestEffort().then((v) => {
    _tempsCache = { ts: Date.now(), value: v };
    _tempsInFlight = null;
    return v;
  }).catch(() => {
    _tempsInFlight = null;
    return null;
  });
  return _tempsInFlight;
}

/**
 * v2.4.29: fetch current temperature readings for trend recording.
 * Returns { cpu_temp_c, gpu_temp_c } where each may be undefined when
 * the live path is unavailable (CPU needs admin + no cache yet; no
 * NVIDIA GPU). The function never throws - all failures degrade to
 * undefined so the scanner's other metrics still record.
 */
async function readTemperaturesBestEffort(): Promise<{ cpu_temp_c?: number; gpu_temp_c?: number } | null> {
  try {
    const { runPowerShellScript } = await import('./scriptRunner.js');
    const r = await runPowerShellScript<any>('Get-Temperatures.ps1', ['-JsonOutput'], { timeoutMs: 10_000 });
    const cpuZones: Array<{ temp_c: number }> = Array.isArray(r?.cpu?.zones) ? r.cpu.zones : [];
    // Use the hottest zone as the CPU temp metric - matches what
    // the UI shows in the summary line.
    const cpuTemp = cpuZones.length > 0
      ? Math.max(...cpuZones.map((z) => z.temp_c))
      : undefined;
    const gpuList: Array<{ temp_c: number | null }> = Array.isArray(r?.gpu) ? r.gpu : [];
    const gpuTemp = gpuList.length > 0 && typeof gpuList[0].temp_c === 'number'
      ? gpuList[0].temp_c
      : undefined;
    return { cpu_temp_c: cpuTemp, gpu_temp_c: gpuTemp };
  } catch {
    return null;
  }
}

export class PCDoctorBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function getStatus(): Promise<SystemStatus> {
  const tStart = performance.now();
  let tRead = 0, tParse = 0, tMap = 0, tSnapshot = 0;

  let raw: string;
  try {
    const t0 = performance.now();
    raw = await readFile(LATEST_JSON_PATH, 'utf8');
    tRead = performance.now() - t0;
  } catch (e: any) {
    void writePerfLine('getStatus.error', performance.now() - tStart, { code: e?.code, at: 'readFile' });
    if (e?.code === 'ENOENT') {
      throw new PCDoctorBridgeError('E_BRIDGE_FILE_MISSING', `No report at ${LATEST_JSON_PATH}`);
    }
    throw new PCDoctorBridgeError('E_BRIDGE_READ_FAILED', `Could not read ${LATEST_JSON_PATH}: ${e?.message}`);
  }

  let parsed: any;
  try {
    const t0 = performance.now();
    // Strip UTF-8 BOM if present. PowerShell's Out-File default encoding writes
    // one; JSON.parse can't handle it.
    const trimmed = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    parsed = JSON.parse(trimmed);
    tParse = performance.now() - t0;
  } catch (e: any) {
    void writePerfLine('getStatus.error', performance.now() - tStart, { code: 'E_BRIDGE_PARSE_FAILED', at: 'JSON.parse' });
    throw new PCDoctorBridgeError('E_BRIDGE_PARSE_FAILED', `Invalid JSON: ${e?.message}`);
  }

  const tMapStart = performance.now();
  const status = mapToSystemStatus(parsed);
  tMap = performance.now() - tMapStart;
  // Persist snapshot for trend tracking (best-effort, non-fatal)
  try {
    const tSnapStart = performance.now();
    const m = parsed.metrics ?? {};
    // v2.4.29: record non-temp metrics synchronously - these are free
    // (pure in-memory reads) and the sync insert is wrapped in a
    // single SQLite txn.
    recordStatusSnapshot({
      cpu_load_pct: typeof m.cpu_load_pct === 'number' ? m.cpu_load_pct : undefined,
      ram_used_pct: typeof m.ram_used_pct === 'number' ? m.ram_used_pct : undefined,
      disks: Array.isArray(m.disks) ? m.disks.map((d: any) => ({ drive: d.drive, free_pct: d.free_pct })) : undefined,
      event_errors_system: m?.event_errors_7d?.system_count,
      event_errors_application: m?.event_errors_7d?.application_count,
    });
    tSnapshot = performance.now() - tSnapStart;
    // v2.4.30: temperature read is fire-and-forget with a 30s cache.
    // v2.4.29 awaited the PS spawn (~200ms) inside getStatus, which on
    // Greg's high-RAM-pressure box (91% used, constant paging) was
    // enough to produce a 30-second UI freeze during window resize
    // (resize -> useStatus re-fire -> PS spawn stampede -> RAM swap).
    // Recording temps async lets getStatus return instantly; caching
    // keeps the PS spawn down to at most one every 30s even when the
    // UI polls more frequently during resize.
    void readTemperaturesCached().then((temps) => {
      if (!temps) return;
      try {
        recordStatusSnapshot({
          cpu_temp_c: temps.cpu_temp_c,
          gpu_temp_c: temps.gpu_temp_c,
        });
      } catch { /* non-fatal */ }
    }).catch(() => {});
  } catch {}
  // Fire notifications for any new critical/warning findings (non-blocking)
  try { emitNewFindingNotifications(status.findings).catch(() => {}); } catch {}

  // v2.4.37: emit per-phase timing so v2.4.38 can diagnose which phase
  // (if any) is actually slow during window resize. total, read, parse,
  // map, snapshot are synchronous-path timings; temp read + notifier
  // are fire-and-forget and not counted here.
  const tTotal = performance.now() - tStart;
  void writePerfLine('getStatus', tTotal, {
    read_ms: Math.round(tRead * 100) / 100,
    parse_ms: Math.round(tParse * 100) / 100,
    map_ms: Math.round(tMap * 100) / 100,
    snapshot_ms: Math.round(tSnapshot * 100) / 100,
    findings: status.findings.length,
  });
  return status;
}

/** Map the real latest.json schema into what the UI expects. */
function mapToSystemStatus(r: any): SystemStatus {
  const m = r.metrics ?? {};
  const kpis: KpiValue[] = [];
  const gauges: GaugeValue[] = [];

  // --- CPU load ---
  if (typeof m.cpu_load_pct === 'number') {
    const cpuSev = classifyLoad(m.cpu_load_pct);
    const cpuDelta = safeWeekDelta('cpu', 'load_pct');
    kpis.push({
      label: 'CPU Load',
      value: m.cpu_load_pct,
      unit: '%',
      severity: cpuSev,
      // v2.4.39 (B50): removed stale "temps require HWiNFO import" note.
      // Temps now come from LHM HTTP / nvidia-smi / SMART cache / MSAcpi
      // (see src/renderer/pages/Dashboard.tsx 7-day trends row). The note
      // was a pre-v2.4.29 leftover AND lived on the wrong card (Load, not
      // temp). Leaving `sub` undefined is fine -- KpiCard tolerates.
      delta: computeDelta(m.cpu_load_pct, cpuDelta.week_ago, 'up'),
    });
    gauges.push({
      label: 'CPU Load',
      value: m.cpu_load_pct,
      display: `${m.cpu_load_pct}%`,
      subtext: cpuSev === 'good' ? 'HEALTHY' : cpuSev === 'warn' ? 'BUSY' : 'OVERLOADED',
      severity: cpuSev,
    });
  }

  // --- RAM usage ---
  if (typeof m.ram_used_pct === 'number') {
    const ramSev = classifyRam(m.ram_used_pct);
    const total = m.ram_total_gb ?? 0;
    const free = m.ram_free_gb ?? 0;
    const ramDelta = safeWeekDelta('ram', 'used_pct');
    kpis.push({
      label: 'RAM Usage',
      value: m.ram_used_pct,
      unit: '%',
      severity: ramSev,
      sub: `${free.toFixed(1)} GB free of ${total.toFixed(1)} GB`,
      delta: computeDelta(m.ram_used_pct, ramDelta.week_ago, 'up'),
    });
    gauges.push({
      label: 'RAM Usage',
      value: m.ram_used_pct,
      display: `${m.ram_used_pct}%`,
      // v2.4.38 (B48): subtext used to read "${free} / ${total} GB" which
      // looked like USED/TOTAL and disagreed with the 'RAM Usage' label +
      // gauge % (which IS used %). Show USED explicitly so the semantic
      // matches. Greg's box: 59.9% used = 38.2 GB of 63.8 GB.
      subtext: `${(total - free).toFixed(1)} / ${total.toFixed(1)} GB`,
      severity: ramSev,
    });
  }

  // --- C: drive free ---
  const disks = Array.isArray(m.disks) ? m.disks : [];
  const cDrive = disks.find((d: any) => d?.drive === 'C:');
  if (cDrive) {
    const sev = classifyDiskFree(cDrive.free_pct);
    const cDelta = safeWeekDelta('disk', 'free_pct', 'C:');
    kpis.push({
      label: 'C: Drive Free',
      value: Math.round(cDrive.free_pct),
      unit: '%',
      severity: sev,
      sub: `${cDrive.free_gb.toFixed(0)} of ${cDrive.size_gb.toFixed(0)} GB`,
      delta: computeDelta(cDrive.free_pct, cDelta.week_ago, 'down'),
    });
    gauges.push({
      label: 'C: Drive Used',
      value: Math.max(0, Math.min(100, 100 - cDrive.free_pct)),
      display: `${Math.round(100 - cDrive.free_pct)}%`,
      subtext: `${(cDrive.size_gb - cDrive.free_gb).toFixed(0)} / ${cDrive.size_gb.toFixed(0)} GB`,
      severity: sev,
    });
  }

  // --- NAS mappings health ---
  const nas = m.nas ?? {};
  const nasMappingsOk = Array.isArray(nas.mappings) ? nas.mappings.length : 0;
  const nasReachable = nas.ping === true && nas.smb_port_open === true;
  const nasSev: Severity = !nasReachable
    ? 'crit'
    : nasMappingsOk === 0
      ? 'warn'
      : 'good';
  kpis.push({
    label: 'NAS',
    value: nasMappingsOk,
    severity: nasSev,
    sub: nasReachable
      ? (nasMappingsOk === 0 ? 'No persistent mappings' : `${nasMappingsOk} mappings`)
      : `Unreachable @ ${nas.ip ?? '-'}`,
  });

  // --- Services summary ---
  const services = m.services ?? {};
  const svcEntries = Object.entries(services) as [string, any][];
  const svcRunning = svcEntries.filter(([, v]) =>
    typeof v?.status === 'string' && /run/i.test(v.status)
  ).length;
  const svcTotal = svcEntries.length;
  const degraded = svcEntries
    .filter(([, v]) => typeof v?.status === 'string' && !/run/i.test(v.status))
    .map(([k]) => k);
  const svcSev: Severity = degraded.length === 0 ? 'good' : degraded.length <= 2 ? 'warn' : 'crit';
  kpis.push({
    label: 'Services',
    value: svcRunning,
    severity: svcSev,
    sub: svcTotal > 0 ? `${svcRunning}/${svcTotal} running${degraded.length ? ` · ${degraded[0]} down` : ''}` : 'No service data',
  });

  // --- Uptime ---
  if (typeof m.uptime_hours === 'number') {
    const hrs = m.uptime_hours;
    const uptimeSev: Severity = hrs > 24 * 30 ? 'warn' : 'good';   // flag if up over a month (install updates)
    kpis.push({
      label: 'Uptime',
      value: Math.round(hrs * 10) / 10,
      severity: uptimeSev,
      sub: hrs < 24 ? `${hrs.toFixed(1)} hours` : `${(hrs / 24).toFixed(1)} days`,
    });
  }

  // --- Overall severity from summary.overall ---
  const overallSev = mapOverall(r.summary?.overall);
  const overallLabel = makeOverallLabel(r.summary);

  // --- generated_at from ISO timestamp ---
  const generated_at = r.timestamp ? Math.floor(Date.parse(r.timestamp) / 1000) : 0;

  const findings: Finding[] = Array.isArray(r.findings) ? r.findings.map((f: any) => {
    const sev: Finding['severity'] = f.severity === 'critical' ? 'critical' : f.severity === 'info' ? 'info' : 'warning';
    return {
      severity: sev,
      area: f.area ?? 'Unknown',
      message: f.message ?? '',
      detail: f.detail,
      auto_fixed: !!f.auto_fixed,
      suggested_action: mapAreaToAction(f),
    };
  }) : [];

  // Services pills
  const rawServices = r.metrics?.services ?? {};
  const serviceList: ServiceHealth[] = Object.entries(rawServices).map(([key, val]: [string, any]) => {
    const statusStr = typeof val?.status === 'string' ? val.status : 'unknown';
    const start = typeof val?.start === 'string' ? val.start : undefined;
    // Severity: running = good, Manual-start + Stopped = good (normal), other Stopped = warn, error = crit
    let sev: 'good' | 'warn' | 'crit';
    // Services that are expected to be stopped/manual and should not show as warn
    // DockerDesktopGUI: user-mode process, may not be running yet at login
    // com.docker.service: Docker Desktop backend; may be Manual after install, OK when not in use
    // WSLService/LxssManager: managed by Docker/WSL2 on demand
    const knownManualStopped = new Set(['BITS', 'wuauserv', 'cryptsvc', 'EFS', 'WSearch', 'DockerDesktopGUI', 'com.docker.service', 'WSLService', 'LxssManager']);
    if (/run/i.test(statusStr)) sev = 'good';
    else if (/error/i.test(statusStr)) sev = 'crit';
    else if (statusStr === 'Stopped' && (start === 'Manual' || start === 'Disabled' || knownManualStopped.has(key))) sev = 'good';
    else if (statusStr === 'Stopped') sev = 'warn';
    else sev = 'warn';
    return {
      key,
      display: val?.display ?? key,
      status: statusStr,
      status_severity: sev,
      start,
      detail: typeof val?.detail === 'string' ? val.detail : undefined,
    };
  });

  // SMART: prefer latest.json embedded data; fall back to cache populated by the Security scan.
  const smart: SmartEntry[] = Array.isArray(r.metrics?.smart) ? r.metrics.smart.map((s: any) => ({
    drive: s.drive ?? 'unknown',
    model: s.model,
    health: s.health ?? 'UNKNOWN',
    wear_pct: s.wear_pct,
    temp_c: s.temp_c,
    media_errors: s.media_errors,
    power_on_hours: s.power_on_hours,
    status_severity: s.health === 'PASSED' ? 'good' : s.health === 'FAILED' ? 'crit' : 'warn',
    // v2.4.18: preserve the admin-required flag. Without it, SmartTable
    // hides the "Run SMART Check (admin)" button and users see "-" with
    // no hint that wear/temp needs elevation.
    needs_admin: s.needs_admin === true,
  })) : cachedSmart;

  // v2.3.0 B4/C1/C3: pass through the rich scanner metrics that power the new
  // WSL recommendation logic, the startup picker, and the RAM pressure panel.
  const rawM = r.metrics ?? {};
  const systemMetrics: SystemMetrics = {};
  if (rawM.wsl_config && typeof rawM.wsl_config === 'object') {
    systemMetrics.wsl_config = {
      exists: !!rawM.wsl_config.exists,
      has_memory_cap: !!rawM.wsl_config.has_memory_cap,
      memory_gb: rawM.wsl_config.memory_gb ?? null,
      vmmem_utilization_pct: rawM.wsl_config.vmmem_utilization_pct ?? null,
    } as WslConfigMetric;
  }
  if (rawM.memory_pressure && typeof rawM.memory_pressure === 'object') {
    systemMetrics.memory_pressure = {
      committed_bytes: rawM.memory_pressure.committed_bytes ?? null,
      commit_limit: rawM.memory_pressure.commit_limit ?? null,
      pages_per_sec: rawM.memory_pressure.pages_per_sec ?? null,
      page_faults_per_sec: rawM.memory_pressure.page_faults_per_sec ?? null,
      compression_mb: rawM.memory_pressure.compression_mb ?? null,
      top_processes: Array.isArray(rawM.memory_pressure.top_processes)
        ? rawM.memory_pressure.top_processes.map((p: any) => ({
            name: String(p.name ?? ''),
            pid: Number(p.pid ?? 0),
            ws_bytes: Number(p.ws_bytes ?? 0),
            kind: (p.kind === 'system' || p.kind === 'service') ? p.kind : 'user',
          }))
        : [],
    } as MemoryPressureMetric;
  }
  if (Array.isArray(rawM.startup_items)) {
    systemMetrics.startup_items = rawM.startup_items.map((it: any) => ({
      name: String(it.name ?? ''),
      location: String(it.location ?? ''),
      kind: it.kind === 'HKLM_Run' || it.kind === 'StartupFolder' ? it.kind : 'Run',
      is_essential: !!it.is_essential,
      disabled_in_registry: !!it.disabled_in_registry,
      publisher: typeof it.publisher === 'string' ? it.publisher : undefined,
      size_bytes: typeof it.size_bytes === 'number' ? it.size_bytes : undefined,
      path: typeof it.path === 'string' ? it.path : undefined,
    })) as StartupItemMetric[];
  }

  return {
    generated_at: Number.isFinite(generated_at) ? generated_at : 0,
    overall_severity: overallSev,
    overall_label: overallLabel,
    host: r.hostname ?? 'Unknown host',
    kpis,
    gauges,
    findings,
    services: serviceList,
    smart,
    metrics: systemMetrics,
  };
}

/**
 * Map a scanner finding to the action that should surface as its
 * one-click fix on the AlertCard (and in Telegram alert inline keyboards).
 *
 * v2.4.35: signature widened from (area) to (finding) so the Reboot case
 * can inspect `detail.flags`. PendingFileRename alone is scrubbable via
 * `clear_stale_pending_renames`; CBS / WU flags require a real reboot and
 * have no one-click fix, so we return undefined in that case.
 *
 * Exported for direct testing.
 */
export function mapAreaToAction(f: { area?: string; detail?: unknown }): ActionName | undefined {
  if (!f.area) return undefined;
  if (f.area === 'Reboot') {
    const d = f.detail as { flags?: unknown } | null | undefined;
    const flags = Array.isArray(d?.flags) ? d!.flags : [];
    if (flags.includes('PendingFileRename')) return 'clear_stale_pending_renames';
    return undefined;
  }
  const map: Record<string, ActionName> = {
    'Memory': 'apply_wsl_cap',
    'Search': 'rebuild_search_index',
    'Explorer': 'fix_shell_overlays',
    'NAS': 'remap_nas',
    'Startup': 'disable_startup_item',
    'Firewall': 'reset_firewall',
    'DNS': 'flush_dns',
    'Temp': 'clear_temp_files',
    'RecycleBin': 'clean_recycle_bin',
    'Browser': 'clean_browser_cache',
    'Docker': 'compact_docker',
    'WinSxS': 'cleanup_winsxs',
    'Defender': 'defender_quick_scan',
    'WindowsUpdate': 'install_windows_updates',
    'Hosts': 'reset_hosts_file',
    'WSL': 'apply_wsl_cap',
    'Overlays': 'fix_shell_overlays',
  };
  return map[f.area];
}

function mapOverall(v: unknown): Severity {
  const s = String(v ?? '').toUpperCase();
  if (s === 'CRITICAL') return 'crit';
  if (s === 'ATTENTION' || s === 'WARNING') return 'warn';
  if (s === 'OK' || s === 'HEALTHY') return 'good';
  return 'good';
}

function makeOverallLabel(summary: any): string {
  if (!summary || typeof summary !== 'object') return 'OK';
  const c = summary.critical ?? 0;
  const w = summary.warning ?? 0;
  const parts: string[] = [];
  if (c > 0) parts.push(`${c} critical`);
  if (w > 0) parts.push(`${w} warning${w === 1 ? '' : 's'}`);
  const state = String(summary.overall ?? 'OK').toUpperCase();
  return parts.length ? `${state} - ${parts.join(', ')}` : state;
}

// Thresholds used for per-metric severity classification
function classifyLoad(p: number): Severity {
  if (p >= 90) return 'crit';
  if (p >= 70) return 'warn';
  return 'good';
}
function classifyRam(p: number): Severity {
  if (p >= 95) return 'crit';
  if (p >= 85) return 'warn';
  return 'good';
}
function classifyDiskFree(p: number): Severity {
  if (p <= 10) return 'crit';
  if (p <= 20) return 'warn';
  return 'good';
}
