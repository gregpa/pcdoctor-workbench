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
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new PCDoctorBridgeError('E_BRIDGE_PARSE_FAILED', `Invalid JSON: ${e?.message}`);
  }

  return mapToSystemStatus(parsed);
}

function sev(v: unknown): Severity {
  return v === 'crit' || v === 'warn' || v === 'info' ? (v as Severity) : 'good';
}

function mapToSystemStatus(r: any): SystemStatus {
  const kpis: KpiValue[] = [];
  const gauges: GaugeValue[] = [];

  if (r.cpu) {
    kpis.push({
      label: 'CPU Temp',
      value: r.cpu.temp_avg_c,
      unit: '°C',
      severity: sev(r.cpu.severity),
      sub: `Peak ${r.cpu.temp_peak_c}°C`,
      delta: r.cpu.delta_week,
    });
    gauges.push({
      label: 'CPU Temperature',
      value: Math.min(100, r.cpu.temp_avg_c),
      display: `${r.cpu.temp_avg_c}°C`,
      subtext: r.cpu.severity === 'warn' || r.cpu.severity === 'crit' ? 'THROTTLING' : 'OK',
      severity: sev(r.cpu.severity),
    });
  }

  if (r.ram) {
    kpis.push({
      label: 'RAM Usage',
      value: r.ram.pct,
      unit: '%',
      severity: sev(r.ram.severity),
      sub: `${r.ram.used_gb} / ${r.ram.total_gb} GB`,
    });
    gauges.push({
      label: 'RAM Usage',
      value: r.ram.pct,
      display: `${r.ram.pct}%`,
      subtext: `${r.ram.used_gb} / ${r.ram.total_gb} GB`,
      severity: sev(r.ram.severity),
    });
  }

  if (r.gpu) {
    kpis.push({
      label: 'GPU Temp',
      value: r.gpu.temp_c,
      unit: '°C',
      severity: sev(r.gpu.severity),
      sub: `Hotspot ${r.gpu.hotspot_c}°C`,
    });
  }

  if (Array.isArray(r.disks) && r.disks.length) {
    const c = r.disks.find((d: any) => d.drive === 'C:') ?? r.disks[0];
    kpis.push({
      label: 'C: Drive Free',
      value: c.free_pct,
      unit: '%',
      severity: sev(c.severity),
      sub: `${c.free_gb} of ${c.total_gb} GB`,
    });
    gauges.push({
      label: 'C: Drive Used',
      value: 100 - c.free_pct,
      display: `${100 - c.free_pct}%`,
      subtext: `${(c.total_gb - c.free_gb).toFixed(0)} / ${c.total_gb} GB`,
      severity: sev(c.severity),
    });
  }

  if (r.nas) {
    kpis.push({
      label: 'NAS Drives',
      value: r.nas.mapped_ok,
      unit: '/12',
      severity: sev(r.nas.severity),
      sub: `${r.nas.mapped_ok}/${r.nas.mapped_total} mapped`,
    });
  }

  if (r.services) {
    kpis.push({
      label: 'Services',
      value: r.services.running,
      unit: '/12',
      severity: sev(r.services.severity),
      sub: r.services.degraded?.length ? `${r.services.degraded[0]} degraded` : 'All running',
    });
  }

  return {
    generated_at: r.generated_at,
    overall_severity: sev(r.overall?.severity),
    overall_label: r.overall?.label ?? 'OK',
    host: r.host ?? 'Unknown host',
    kpis,
    gauges,
  };
}
