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

export interface SystemStatus {
  generated_at: number; // unix seconds
  overall_severity: Severity;
  overall_label: string;
  host: string;
  kpis: KpiValue[];
  gauges: GaugeValue[];
  findings: Finding[];
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
