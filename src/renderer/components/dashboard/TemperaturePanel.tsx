/**
 * TemperaturePanel (v2.4.28)
 *
 * Dashboard tile aggregating CPU / GPU / NVMe temperatures. Greg's ask
 * after replacing a PC radiator - "I would like to track" temperatures
 * going forward.
 *
 * Data sources:
 *   - CPU      WMI MSAcpi_ThermalZoneTemperature (admin only; cached
 *              for non-admin reads)
 *   - GPU      nvidia-smi (NVIDIA only; AMD + Intel not yet wired)
 *   - NVMe/SSD SMART cache populated by Run-SmartCheck (v2.4.18-21)
 *
 * Severity thresholds:
 *   GPU  >85 C warn, >90 C crit
 *   CPU  >85 C warn, >95 C crit
 *   Disk >60 C warn, >70 C crit
 *
 * Collapsible with localStorage-persisted state, same pattern as the
 * NAS Drives & Storage panel.
 */
import { useCallback, useEffect, useState } from 'react';
import type { IpcResult, TemperatureReport } from '@shared/types.js';

interface TempApi {
  getTemperatures?: () => Promise<IpcResult<TemperatureReport>>;
}

export interface TemperaturePanelProps {
  /** Optional trigger to elevate + refresh CPU temp. Parent wires this
   *  to handleAction('run_smart_check') or a future dedicated refresh
   *  action. Omitted for now; the admin button fires a future action. */
  onRefreshAdmin?: () => void | Promise<void>;
}

const COLLAPSE_KEY = 'pcdoctor:temperature-panel-collapsed';

function severityForTemp(temp: number | null, warnAt: number, critAt: number): 'good' | 'warn' | 'crit' | 'unknown' {
  if (temp === null || temp === undefined) return 'unknown';
  if (temp >= critAt) return 'crit';
  if (temp >= warnAt) return 'warn';
  return 'good';
}

function sevClass(sev: 'good' | 'warn' | 'crit' | 'unknown'): string {
  switch (sev) {
    case 'crit':    return 'text-status-crit';
    case 'warn':    return 'text-status-warn';
    case 'good':    return 'text-status-good';
    case 'unknown': return 'text-text-secondary';
  }
}

function sevBadgeClass(sev: 'good' | 'warn' | 'crit' | 'unknown'): string {
  switch (sev) {
    case 'crit':    return 'bg-status-crit/20 text-status-crit border-status-crit/40';
    case 'warn':    return 'bg-status-warn/20 text-status-warn border-status-warn/40';
    case 'good':    return 'bg-status-good/20 text-status-good border-status-good/40';
    case 'unknown': return 'bg-surface-700 text-text-secondary border-surface-600';
  }
}

function fmtTemp(t: number | null | undefined): string {
  if (t === null || t === undefined) return '-';
  return `${t} °C`;
}

export function TemperaturePanel({ onRefreshAdmin }: TemperaturePanelProps) {
  const [report, setReport] = useState<TemperatureReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === '1'; } catch { return false; }
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0'); } catch { /* storage denied */ }
      return next;
    });
  }, []);

  const load = useCallback(async () => {
    const api = (window as unknown as { api?: TempApi }).api;
    if (!api?.getTemperatures) {
      setError('Temperature API unavailable in this build');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      const r = await api.getTemperatures();
      if (r.ok) {
        setReport(r.data);
      } else {
        setError(r.error?.message ?? 'Failed to read temperatures');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Auto-refresh every 60 s so the GPU reading stays live. Cheap
    // - just runs nvidia-smi + reads a JSON file.
    const iv = window.setInterval(() => { void load(); }, 60_000);
    return () => window.clearInterval(iv);
  }, [load]);

  // Summary line for the collapsed-header
  const hottestPart = (() => {
    if (!report) return loading ? 'loading...' : error ? 'error' : '';
    return report.message;
  })();

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Expand Temperatures' : 'Collapse Temperatures'}
          className="text-[9.5px] uppercase tracking-wider text-text-secondary hover:text-text-primary font-semibold flex items-center gap-1.5"
        >
          <span className="text-xs">{collapsed ? '▸' : '▾'}</span>
          <span>🌡</span>
          <span>Temperatures</span>
          {hottestPart && (
            <span className="ml-1 normal-case tracking-normal text-text-secondary font-normal">
              - {hottestPart}
            </span>
          )}
        </button>
        {!collapsed && (
          <div className="flex items-center gap-3">
            {report?.cpu.needs_admin && onRefreshAdmin && (
              <button
                onClick={() => void onRefreshAdmin()}
                className="px-2 py-0.5 rounded text-[10px] bg-status-warn/15 border border-status-warn/40 text-status-warn hover:bg-status-warn/25"
                title="CPU temperature via WMI requires admin. Click to UAC-elevate + refresh."
              >
                🌡 Refresh CPU (admin)
              </button>
            )}
            <button
              onClick={() => void load()}
              className="text-[10px] text-text-secondary hover:text-text-primary underline-offset-2 hover:underline"
              aria-label="Refresh temperatures"
            >
              Refresh
            </button>
          </div>
        )}
      </div>

      {collapsed ? null : error ? (
        <div className="text-[11px] text-status-warn">{error}</div>
      ) : !report ? (
        <div className="text-[11px] text-text-secondary">Reading sensors...</div>
      ) : (
        <div className="space-y-2.5">
          {/* CPU */}
          <TempRow
            label="CPU"
            icon="🧠"
            temp={report.cpu.zones.length > 0 ? Math.max(...report.cpu.zones.map(z => z.temp_c)) : null}
            warnAt={85}
            critAt={95}
            extra={
              report.cpu.needs_admin && report.cpu.zones.length === 0
                ? 'admin required - click Refresh CPU to read'
                : report.cpu.zones.length > 1
                  ? `${report.cpu.zones.length} zones${report.cpu.from_cache ? ' (cached)' : ''}`
                  : report.cpu.from_cache ? 'cached' : undefined
            }
          />

          {/* GPU(s) */}
          {report.gpu.length === 0 ? (
            <TempRow label="GPU" icon="🎮" temp={null} warnAt={85} critAt={90} extra="no nvidia-smi data (non-NVIDIA GPU or driver not installed)" />
          ) : (
            report.gpu.map((g, i) => (
              <TempRow
                key={i}
                label={`GPU ${g.name}`}
                icon="🎮"
                temp={g.temp_c}
                warnAt={85}
                critAt={90}
                extra={[
                  g.fan_pct !== null ? `fan ${g.fan_pct}%` : null,
                  g.utilization_pct !== null ? `util ${g.utilization_pct}%` : null,
                  g.memory_temp_c !== null ? `mem ${g.memory_temp_c} °C` : null,
                ].filter(Boolean).join(' · ')}
              />
            ))
          )}

          {/* Disks */}
          {report.disks.length === 0 ? null : (
            report.disks.map((d, i) => (
              <TempRow
                key={i}
                label={d.model}
                icon="💾"
                temp={d.temp_c}
                warnAt={60}
                critAt={70}
                extra={d.needs_admin ? 'admin required (run SMART Check)' : d.source}
              />
            ))
          )}
        </div>
      )}

      {!collapsed && report && (
        <div className="mt-2 text-[9.5px] text-text-secondary italic">
          Refreshes every 60s. Thresholds: CPU warn/crit 85/95 °C, GPU 85/90 °C, disk 60/70 °C.
          CPU zone read needs admin - click Refresh CPU to UAC-elevate.
          AMD/Intel GPU temps not yet wired (only NVIDIA via nvidia-smi).
        </div>
      )}
    </div>
  );
}

function TempRow({
  label, icon, temp, warnAt, critAt, extra,
}: {
  label: string;
  icon: string;
  temp: number | null;
  warnAt: number;
  critAt: number;
  extra?: string;
}) {
  const sev = severityForTemp(temp, warnAt, critAt);
  const pct = temp === null ? 0 : Math.min(100, Math.max(0, Math.round((temp / critAt) * 100)));
  return (
    <div className="border border-surface-700 rounded-md p-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[14px]">{icon}</span>
        <span className="text-[11px] font-semibold flex-1 truncate">{label}</span>
        <span className={`text-[11px] font-mono ${sevClass(sev)}`}>
          {fmtTemp(temp)}
        </span>
        <span className={`text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${sevBadgeClass(sev)}`}>
          {sev}
        </span>
      </div>
      {extra && (
        <div className="text-[9.5px] text-text-secondary pl-6 mb-1">{extra}</div>
      )}
      <div className="relative h-1 w-full rounded bg-surface-700 overflow-hidden">
        <div
          className={
            sev === 'crit' ? 'bg-status-crit absolute left-0 top-0 bottom-0'
            : sev === 'warn' ? 'bg-status-warn absolute left-0 top-0 bottom-0'
            : sev === 'good' ? 'bg-status-good absolute left-0 top-0 bottom-0'
            :                   'bg-surface-600 absolute left-0 top-0 bottom-0'
          }
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
