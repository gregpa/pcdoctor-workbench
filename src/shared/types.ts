// --- System status (from reports/latest.json) ---
export type Severity = 'good' | 'warn' | 'crit' | 'info';

export interface KpiValue {
  label: string;
  value: number;
  unit?: '°C' | '%' | 'GB' | 'MHz' | '/12';
  severity: Severity;
  sub?: string;
  delta?: { direction: 'up' | 'down' | 'neutral'; text: string; severity: Severity };
}

export interface GaugeValue {
  label: string;
  value: number;        // normalized 0..100 for gauge
  display: string;      // what to render in the center (e.g., "82°C", "61%")
  subtext: string;      // small text below center ("THROTTLING", "19.5 / 32 GB")
  severity: Severity;
}

export interface Finding {
  severity: 'critical' | 'warning' | 'info';
  area: string;
  message: string;
  detail?: unknown;
  auto_fixed: boolean;
  suggested_action?: ActionName;
}

export interface TrendPoint {
  ts: number;       // unix seconds
  value: number;
}

export interface Trend {
  metric: string;   // e.g., 'cpu.load_pct', 'ram.used_pct', 'disk.C.free_pct', 'events.system_7d'
  unit: string;
  points: TrendPoint[];
  healthy_max?: number;
  healthy_min?: number;
}

export interface SmartEntry {
  drive: string;              // e.g. 'NVMe C: (1 TB)'
  model?: string;
  health: 'PASSED' | 'FAILED' | 'UNKNOWN';
  wear_pct?: number;          // 0..100
  temp_c?: number;
  media_errors?: number;
  power_on_hours?: number;
  status_severity: 'good' | 'warn' | 'crit';
}

export interface ServiceHealth {
  key: string;                // e.g., 'Cloudflared'
  display: string;            // 'Cloudflare Tunnel'
  status: string;             // raw status string from PS
  status_severity: 'good' | 'warn' | 'crit';
  start?: string;             // 'Automatic' | 'Manual' | 'Disabled'
  detail?: string;
}

export interface SystemStatus {
  generated_at: number; // unix seconds
  overall_severity: Severity;
  overall_label: string;
  host: string;
  kpis: KpiValue[];
  gauges: GaugeValue[];
  findings: Finding[];
  services?: ServiceHealth[];
  smart?: SmartEntry[];
}

// --- Actions ---
export type ActionName =
  // Cleanup
  | 'flush_dns'
  | 'clear_temp_files'
  | 'clean_recycle_bin'
  | 'clean_browser_cache'
  | 'cleanup_winsxs'
  | 'clean_onedrive_cache'
  | 'clean_teams_cache'
  | 'clean_discord_cache'
  | 'clean_spotify_cache'
  // Repair
  | 'rebuild_search_index'
  | 'run_sfc'
  | 'run_dism'
  | 'trim_ssd'
  | 'generate_system_report'
  // Network
  | 'release_renew_ip'
  | 'reset_winsock'
  | 'reset_firewall'
  | 'flush_arp_cache'
  | 'reset_network_adapters'
  | 'remap_nas'
  // Service / Process
  | 'restart_service'
  | 'restart_explorer'
  | 'restart_network_stack'
  | 'kill_process'
  // Performance
  | 'compact_docker'
  | 'apply_wsl_cap'
  | 'fix_shell_overlays'
  | 'disable_startup_item'
  // Security
  | 'reset_hosts_file'
  // Internal (not shown in UI)
  | 'create_restore_point';

export type ActionCategory =
  | 'cleanup'
  | 'repair'
  | 'network'
  | 'service'
  | 'perf'
  | 'security'
  | 'internal';

export interface ActionResult {
  action: ActionName;
  success: boolean;
  duration_ms: number;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}

// --- IPC envelope ---
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError };

export interface IpcError {
  code: string;
  message: string;
  details?: unknown;
}

export interface AuditLogEntry {
  id: number;
  ts: number;
  action_name: string;
  action_label: string;
  status: 'running' | 'success' | 'error';
  duration_ms: number | null;
  error_message: string | null;
  rollback_id: number | null;
  reverted_at: number | null;
  triggered_by: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
}

export interface RunActionRequest {
  name: ActionName;
  params?: Record<string, string | number>;
}

export interface RevertResult {
  method: 'system-restore' | 'file-snapshot' | 'none';
  reboot_required: boolean;
  details: string;
}

export interface ForecastProjection {
  metric: string;               // 'disk.C.free_pct' etc.
  metric_label: string;         // 'C: drive free %'
  algorithm: 'linear_regression' | 'ewma' | 'categorical';
  current_value: number;
  slope_per_day: number | null;
  r_squared: number | null;
  threshold_warn: number | null;
  threshold_critical: number | null;
  projected_warn_date: string | null;     // ISO date
  projected_critical_date: string | null;
  days_until_critical: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT';
  confidence_score: number;     // 0..1
  severity: 'critical' | 'important' | 'low' | 'indicator';
  preventive_action?: {
    action_name: string;        // matches an ActionName
    label: string;
    recommended_before: string | null;
  };
}

export interface ForecastData {
  generated_at: number;         // unix seconds
  projections: ForecastProjection[];
  insufficient_data: Array<{ metric: string; points: number; required: number }>;
}
