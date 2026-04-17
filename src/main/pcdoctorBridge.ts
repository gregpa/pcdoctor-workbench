import { readFile } from 'node:fs/promises';
import { LATEST_JSON_PATH } from './constants.js';
import type { SystemStatus, KpiValue, GaugeValue, Severity } from '@shared/types.js';

export class PCDoctorBridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function getStatus(): Promise<SystemStatus> {
  let raw: string;
  try {
    raw = await readFile(LATEST_JSON_PATH, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOENT') {
      throw new PCDoctorBridgeError('E_BRIDGE_FILE_MISSING', `No report at ${LATEST_JSON_PATH}`);
    }
    throw new PCDoctorBridgeError('E_BRIDGE_READ_FAILED', `Could not read ${LATEST_JSON_PATH}: ${e?.message}`);
  }

  let parsed: any;
  try {
    // Strip UTF-8 BOM if present. PowerShell's Out-File default encoding writes
    // one; JSON.parse can't handle it.
    const trimmed = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    parsed = JSON.parse(trimmed);
  } catch (e: any) {
    throw new PCDoctorBridgeError('E_BRIDGE_PARSE_FAILED', `Invalid JSON: ${e?.message}`);
  }

  return mapToSystemStatus(parsed);
}

/** Map the real latest.json schema into what the UI expects. */
function mapToSystemStatus(r: any): SystemStatus {
  const m = r.metrics ?? {};
  const kpis: KpiValue[] = [];
  const gauges: GaugeValue[] = [];

  // --- CPU load ---
  if (typeof m.cpu_load_pct === 'number') {
    const cpuSev = classifyLoad(m.cpu_load_pct);
    kpis.push({
      label: 'CPU Load',
      value: m.cpu_load_pct,
      unit: '%',
      severity: cpuSev,
      sub: 'Note: temps require HWiNFO import',
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
    kpis.push({
      label: 'RAM Usage',
      value: m.ram_used_pct,
      unit: '%',
      severity: ramSev,
      sub: `${free.toFixed(1)} GB free of ${total.toFixed(1)} GB`,
    });
    gauges.push({
      label: 'RAM Usage',
      value: m.ram_used_pct,
      display: `${m.ram_used_pct}%`,
      subtext: `${free.toFixed(1)} / ${total.toFixed(1)} GB`,
      severity: ramSev,
    });
  }

  // --- C: drive free ---
  const disks = Array.isArray(m.disks) ? m.disks : [];
  const cDrive = disks.find((d: any) => d?.drive === 'C:');
  if (cDrive) {
    const sev = classifyDiskFree(cDrive.free_pct);
    kpis.push({
      label: 'C: Drive Free',
      value: Math.round(cDrive.free_pct),
      unit: '%',
      severity: sev,
      sub: `${cDrive.free_gb.toFixed(0)} of ${cDrive.size_gb.toFixed(0)} GB`,
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
      : `Unreachable @ ${nas.ip ?? '—'}`,
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

  return {
    generated_at: Number.isFinite(generated_at) ? generated_at : 0,
    overall_severity: overallSev,
    overall_label: overallLabel,
    host: r.hostname ?? 'Unknown host',
    kpis,
    gauges,
  };
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
  return parts.length ? `${state} — ${parts.join(', ')}` : state;
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
