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
  /**
   * v2.4.6: optional long-form explanation emitted by the scanner.
   * Displayed in AlertDetailModal's "Why this matters" section. Falls
   * back to a static map on the renderer side if absent — which makes
   * this backward-compatible with older scanner reports.
   */
  why?: string;
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
  health: 'PASSED' | 'FAILED' | 'UNKNOWN' | 'WARN';
  wear_pct?: number | null;          // 0..100
  temp_c?: number | null;
  media_errors?: number | null;
  power_on_hours?: number | null;
  status_severity: 'good' | 'warn' | 'crit';
  /** True when the row came from Get-PhysicalDisk fallback (non-admin);
   *  wear/temp/media_errors are unavailable and the UI should prompt the
   *  user to Run SMART Health Check for full data. */
  needs_admin?: boolean;
}

export interface ServiceHealth {
  key: string;                // e.g., 'Cloudflared'
  display: string;            // 'Cloudflare Tunnel'
  status: string;             // raw status string from PS
  status_severity: 'good' | 'warn' | 'crit';
  start?: string;             // 'Automatic' | 'Manual' | 'Disabled'
  detail?: string;
}

/** v2.3.0 — optional rich system metrics surfaced from Invoke-PCDoctor.ps1 */
export interface WslConfigMetric {
  exists: boolean;
  has_memory_cap: boolean;
  memory_gb: number | null;
  vmmem_utilization_pct: number | null;
}

export interface MemoryPressureMetric {
  committed_bytes: number | null;
  commit_limit: number | null;
  pages_per_sec: number | null;
  page_faults_per_sec: number | null;
  compression_mb: number | null;
  top_processes?: Array<{
    name: string;
    pid: number;
    ws_bytes: number;
    kind: 'user' | 'service' | 'system';
  }>;
}

export interface StartupItemMetric {
  name: string;
  location: string;
  kind: 'Run' | 'StartupFolder' | 'HKLM_Run';
  is_essential: boolean;
  disabled_in_registry: boolean;
  publisher?: string;
  size_bytes?: number;
  path?: string;
  /** v2.4.13: true when this item appears in the user's startup_allowlist
   * (set via StartupPickerModal's "Never warn" toggle). Allowlisted items
   * are still listed in the scan but excluded from the warn-threshold count. */
  allowlisted?: boolean;
}

export interface SystemMetrics {
  wsl_config?: WslConfigMetric;
  memory_pressure?: MemoryPressureMetric;
  startup_items?: StartupItemMetric[];
  /** v2.4.6: list of pending-reboot flags (CBS, WU, PendingFileRename, ...) */
  pending_reboot?: string[];
  /** v2.4.6: uptime in hours, surfaced for "do I really need to reboot" UX */
  uptime_hours?: number;
  /** v2.4.13: current startup threshold (echoed from settings for UI). */
  startup_threshold?: number;
  /** v2.4.13: count of items currently on the startup allowlist. */
  startup_allowlist_count?: number;
}

/**
 * v2.5.2: live status of the CPU temperature source pipeline.
 *
 * Populated from the most recent successful Get-Temperatures.ps1
 * invocation (fire-and-forget after each getStatus). The renderer uses
 * `lhm_http_open === false` to surface a Dashboard banner when the
 * LHM Remote Web Server toggle has flipped off — observed 2026-04-29
 * after a non-clean shutdown silently dropped the setting and Greg
 * lost a half-day of CPU temp trend before noticing.
 *
 * Undefined on cold-launch before the first temp read resolves
 * (~30s) — renderers should hide the banner until the field appears.
 */
export interface CpuTempStatus {
  /** 'LibreHardwareMonitor HTTP' | 'LibreHardwareMonitor WMI' | 'MSAcpi_ThermalZoneTemperature' | 'cache' | 'none' */
  source: string;
  /** True when the live read failed and the panel is rendering a stale cache value (≤6h old). */
  from_cache: boolean;
  /** True when the TCP probe to 127.0.0.1:8085 succeeded this scan. False = LHM Remote Web Server is off OR LHM is not running. */
  lhm_http_open: boolean;
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
  metrics?: SystemMetrics;
  cpu_temp_status?: CpuTempStatus;
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
  | 'import_hwinfo_csv'
  // Network
  | 'release_renew_ip'
  | 'reset_winsock'
  | 'reset_firewall'
  | 'open_firewall_console'
  | 'open_windows_security'
  | 'clear_stale_pending_renames'
  | 'disable_firewall_temporarily'
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
  | 'defender_quick_scan' | 'defender_full_scan' | 'update_defender_defs'
  // Windows Update
  | 'install_windows_updates' | 'install_security_updates' | 'repair_windows_update'
  | 'hide_kb' | 'install_kb'
  | 'create_shadow_copy' | 'enable_bitlocker' | 'block_ip' | 'run_mbam_scan'
  | 'run_dell_command_update' | 'import_occt_csv'
  | 'unblock_ip'
  | 'analyze_minidump'
  // v2.1.4 additions
  | 'clear_browser_caches'
  | 'shrink_component_store'
  | 'remove_feature_update_leftovers'
  | 'empty_recycle_bins'
  | 'enable_pua_protection'
  | 'enable_controlled_folder_access'
  | 'update_hosts_stevenblack'
  // v2.2.0 - Autopilot tool-runners
  | 'run_smart_check'
  | 'run_malwarebytes_cli'
  | 'run_adwcleaner_scan'
  | 'run_safety_scanner'
  | 'run_hwinfo_log'
  | 'parse_hwinfo_delta'
  // v2.3.0 - Batch startup disable
  | 'disable_startup_items_batch'
  // v2.4.13 - Per-NAS-drive @Recycle empty (QNAP/Synology convention)
  | 'empty_nas_recycle_bin'
  // v2.4.27 - Launch NVIDIA App / GeForce Experience / Control Panel
  | 'open_nvidia_app'
  // Internal (not shown in UI)
  | 'create_restore_point';

export type ActionCategory =
  | 'cleanup'
  | 'repair'
  | 'network'
  | 'service'
  | 'perf'
  | 'security'
  | 'update'
  | 'hardening'
  | 'disk'
  | 'diagnostic'
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
  dry_run?: boolean;
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
  insufficient_data: Array<{
    metric: string;
    points: number;
    required: number;
    days_span?: number;
    days_required?: number;
    reason?: 'not_enough_points' | 'not_enough_span';
  }>;
}

export interface WeeklyReviewActionItem {
  id: string;
  priority: 'critical' | 'important' | 'info';
  area: string;
  message: string;
  detail?: unknown;
  suggested_action?: { action_name: string; label: string };
  state?: 'pending' | 'applied' | 'dismissed' | 'snoozed' | 'auto_resolved';
}

export interface WeeklyReview {
  review_date: string;
  generated_at: number;
  hostname: string;
  summary: { overall: string; critical_count: number; warning_count: number; info_count: number };
  action_items: WeeklyReviewActionItem[];
  headroom: Record<string, string>;
  forecast_digest: unknown[];
  has_pending_flag: boolean;
}

// --- Security posture ---
export interface DefenderStatus {
  realtime_protection: boolean;
  antispyware_enabled: boolean;
  defs_version: string;
  defs_age_hours: number;
  engine_version: string;
  last_quick_scan_hours: number | null;
  last_full_scan_days: number | null;
  threats_quarantined_7d: number;
  threats_active: number;
  tamper_protection: boolean;
  cloud_protection: boolean;
  puaprotection: string;
  controlled_folder_access: string;
  network_protection: string;
  exclusions_count: number;
  severity: 'good' | 'warn' | 'crit';
}

export interface FirewallStatus {
  domain_enabled: boolean;
  private_enabled: boolean;
  public_enabled: boolean;
  default_inbound_action: string;
  rules_total: number;
  rules_added_7d: number;
  severity: 'good' | 'warn' | 'crit';
}

export interface WindowsUpdatePosture {
  pending_count: number;
  pending_security_count: number;
  last_success_days: number | null;
  reboot_pending: boolean;
  wu_service_status: string;
  severity: 'good' | 'warn' | 'crit';
}

export interface FailedLoginSummary {
  total_7d: number;
  total_24h: number;
  lockouts_7d: number;
  top_sources: Array<{
    ip: string;
    count: number;
    country?: string | null;
    city?: string | null;
    isp?: string | null;
    org?: string | null;
  }>;
  rdp_attempts_7d: number;
  severity: 'good' | 'warn' | 'crit';
}

export interface BitLockerVolume {
  drive: string;
  status: string;              // 'FullyEncrypted' | 'EncryptionInProgress' | 'FullyDecrypted' | etc.
  protection_on: boolean;
  encryption_pct: number;
}

export interface UacStatus {
  enabled: boolean;
  level: 'AlwaysNotify' | 'Default' | 'NotifyChanges' | 'Disabled' | 'Unknown';
  severity: 'good' | 'warn' | 'crit';
}

export interface DriverFreshness {
  gpu_vendor: string;
  gpu_current_version: string;
  age_days: number | null;
  severity: 'good' | 'warn' | 'crit';
}

export interface PersistenceItem {
  kind: 'startup' | 'scheduled_task' | 'service' | 'wmi_sub' | 'browser_ext';
  identifier: string;          // stable id (hash of path+name+kind)
  name: string;
  path?: string;
  publisher?: string;
  signed?: boolean;
  first_seen: number;          // unix ms
  last_seen: number;
  approved: 0 | 1 | -1;        // 0 = unknown, 1 = approved, -1 = rejected
  is_new: boolean;             // added in the most recent scan
}

export interface ThreatIndicator {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;            // 'ransomware' | 'cryptominer' | 'suspicious_powershell' | 'lolbas' | 'unusual_parent_child' | 'rdp_bruteforce'
  detected_at: number;
  message: string;
  detail?: Record<string, unknown>;
}

export interface SecurityPosture {
  generated_at: number;
  defender: DefenderStatus | null;
  firewall: FirewallStatus | null;
  windows_update: WindowsUpdatePosture | null;
  failed_logins: FailedLoginSummary | null;
  bitlocker: BitLockerVolume[];
  uac: UacStatus | null;
  gpu_driver: DriverFreshness | null;
  persistence_new_count: number;
  persistence_items: PersistenceItem[];
  threat_indicators: ThreatIndicator[];
  smart: SmartEntry[];
  overall_severity: 'good' | 'warn' | 'crit';
  /**
   * v2.4.51 (B51-IPC-1): per-sub-scan failure detail emitted when one of the
   * non-primary PS scans (Audit-Persistence, Get-ThreatIndicators, Get-SMART)
   * rejects. Optional so older saved postures that pre-date the field
   * deserialize unchanged. Renderer UI for the badge ships in v2.4.52.
   */
  partial_errors?: Array<{ name: string; code: string; message: string }>;
}

export interface ToolStatus {
  id: string;
  installed: boolean;
  resolved_path: string | null;
}

// --- Notification settings ---
export interface NotificationSettings {
  telegram_enabled: boolean;
  telegram_bot_token: string;      // DPAPI-encrypted at rest; masked in getSettings responses; revealed only via api:revealTelegramToken.
  telegram_chat_id: string;
  quiet_hours_start: number;       // Hour 0-23
  quiet_hours_end: number;
  events: Record<string, { toast: boolean; telegram: boolean }>;
}

export const DEFAULT_NOTIFICATION_EVENTS = [
  'critical_finding',
  'warning_finding',
  'weekly_review_ready',
  'action_failed',
  'action_succeeded',
  'pending_updates_security',
  'forecast_critical',
] as const;

export type NotificationEvent = typeof DEFAULT_NOTIFICATION_EVENTS[number];

// --- Temperatures (v2.4.28) ---
export interface TemperatureReport {
  generated_at: number;
  cpu: {
    zones: Array<{ name: string; temp_c: number }>;
    /** True when WMI thermal-zone query needs elevation (typical for
     *  non-admin Dashboard scans). UI shows "admin required" + a
     *  Refresh button that elevates. */
    needs_admin: boolean;
    /** True when cpu.zones came from a stale-tolerant cache file
     *  (previous elevated run) rather than a fresh WMI read. */
    from_cache: boolean;
  };
  gpu: Array<{
    vendor: string;
    name: string;
    temp_c: number | null;
    memory_temp_c: number | null;
    fan_pct: number | null;
    utilization_pct: number | null;
  }>;
  disks: Array<{
    drive: string;
    model: string;
    temp_c: number | null;
    kind: string;
    source: string;
    needs_admin: boolean;
  }>;
  message: string;
}

// --- Scheduled tasks ---
export interface ScheduledTaskInfo {
  name: string;
  status: string;        // Ready | Disabled | Running | etc.
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
}
