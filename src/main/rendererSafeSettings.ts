/**
 * Allowlist of workbench_settings keys that the renderer is permitted to
 * read via api:getSettings.
 *
 * v2.5.9 caught a recurring bug class: main-side code calls setSetting()
 * to cache something (e.g. nvidia driver check result), then renderer-side
 * code calls api.getSettings() to hydrate from that cache. Pre-fix, the
 * cache was silently dropped at the IPC filter because the new key wasn't
 * in this allowlist. The feature looked fine in the unit tests (which
 * exercised dataStore directly), but was broken on every cold start in
 * prod because nothing exercised the IPC filter chain end-to-end.
 *
 * v2.5.15 extracted the constant + filter helpers so they can be unit
 * tested without the Electron app boot path. Adding a new cached setting:
 *   1. Read/write it via dataStore in main-process code.
 *   2. ALSO add the key to RENDERER_SAFE_KEYS below.
 *   3. tests/main/rendererSafeSettings.test.ts will fail until you do.
 */

export const RENDERER_SAFE_KEYS: ReadonlySet<string> = new Set<string>([
  // telegram_bot_token IS in the allowlist but the IPC handler ALSO masks
  // it before returning to the renderer (ipc.ts:api:getSettings). The mask
  // is the real privacy guard; this allowlist entry just permits the masked
  // form to flow through. Renderer never sees plaintext via api.getSettings.
  'telegram_bot_token', 'telegram_chat_id', 'telegram_enabled',
  'quiet_hours_start', 'quiet_hours_end',
  'email_digest_recipient', 'digest_hour',
  'auto_block_rdp_bruteforce',
  'telegram_last_good_ts', 'selftest_banner',
  'obsidian_archive_dir',
  // v2.5.9 (B4): Nvidia driver check cache (driver versions + epoch ms,
  // no sensitive data). Written main-side by api:getNvidiaDriverLatest;
  // read renderer-side on Updates.tsx mount to hydrate staleness UI.
  'nvidia_check_cache',
  // v2.5.17: first-run wizard completion flag. '1' when the wizard has been
  // dismissed. Read renderer-side on mount to skip the wizard on subsequent
  // launches. Written by the wizard via api:setSetting.
  'first_run_complete',
  // Configurable forecast thresholds (wizard-prep Task 3)
  'forecast_cpu_temp_warn', 'forecast_cpu_temp_crit',
  'forecast_gpu_temp_warn', 'forecast_gpu_temp_crit',
  'forecast_ram_warn_pct', 'forecast_ram_crit_pct',
  'forecast_cpu_load_warn', 'forecast_cpu_load_crit',
  'forecast_disk_free_warn', 'forecast_disk_free_crit',
  'forecast_events_warn', 'forecast_events_crit',
  // v2.5.18: wizard-persisted settings
  'nas_enabled', 'nas_brand',
  'obsidian_enabled', 'wsl_memory_limit_gb', 'claude_detected',
  'wizard_completed_at', 'wizard_version',
  'autopilot_enabled',
]);

/**
 * True if the key is allowed to be returned to the renderer. Includes the
 * `event:*` namespace which carries per-event toast/telegram channel
 * preferences (event:smart-warning:toast, etc.) — there are too many to
 * enumerate, and they're never sensitive.
 */
export function isRendererSafeKey(key: string): boolean {
  return RENDERER_SAFE_KEYS.has(key) || key.startsWith('event:');
}

/**
 * Returns a copy of `all` containing only renderer-safe keys. Sensitive-
 * value MASKING (e.g. telegram_bot_token) happens AFTER this filter in
 * the IPC handler — this function is the boundary, not the redactor.
 */
export function filterRendererSafeSettings(
  all: Readonly<Record<string, string>>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) {
    if (isRendererSafeKey(k)) filtered[k] = v;
  }
  return filtered;
}
