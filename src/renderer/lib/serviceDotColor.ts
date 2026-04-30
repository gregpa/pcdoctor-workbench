import type { ServiceHealth } from '@shared/types.js';

/**
 * Single source of truth for the service-status dot color used by both
 * the Dashboard tile (ServicePill) and the detail popup (ServiceDetailModal).
 *
 * Pre-v2.5.10 these diverged: the tile derived color from raw status+start
 * (literal runtime view), while the modal trusted backend status_severity
 * (which classifies Stopped+Manual as 'good' = "expected"). Same service,
 * different colors. The literal runtime view wins because it's what the
 * user expects — yellow for stopped, green for running, regardless of
 * whether the backend considers the stopped state "normal" for the role.
 *
 * Backend status_severity is preserved and still drives autopilot rules
 * and other consumers; only the dashboard dot uses this helper.
 *
 * Status string sources (raw from PowerShell scanner):
 *   "Running"                      — Get-Service .Status
 *   "Stopped"                      — Get-Service .Status
 *   "StartPending" / "StopPending" — Get-Service .Status (rare)
 *   "Paused"                       — Get-Service .Status (rare)
 *   "running (N procs)"            — Docker GUI hash emitter
 *   "NOT RUNNING"                  — Docker GUI hash emitter
 *   "service-running"              — Cloudflared emitter
 *   "service-stopped"/"service-paused"/"service-start pending"
 *   "process-running"              — Cloudflared emitter
 *   "OFFLINE"                      — Cloudflared (nothing running)
 *   "not_installed"                — scanner (absent service)
 */
export function deriveServiceDotColor(service: ServiceHealth): string {
  const s = (service.status || '').toLowerCase();
  // Reject "not running" variants first; they contain the substring
  // "running" but represent a stopped/absent state.
  const isNotRunning = s.includes('not running') || s === 'offline' || s === 'not_installed';
  // Detect actual running. (^|-|\s) prefix permits "service-running" /
  // "process-running" Cloudflared variants.
  const isRunning = !isNotRunning && /(^|-|\s)running\b/.test(s);
  const isStopped = /\bstopped\b/.test(s) || s === 'not_installed' || isNotRunning;
  const stoppedAuto = isStopped && service.start === 'Automatic';
  const stoppedManual = isStopped && (service.start === 'Manual' || service.start === 'Disabled' || !service.start);
  if (isRunning) return 'bg-status-good';
  if (stoppedAuto) return 'bg-status-crit';
  if (stoppedManual) return 'bg-status-warn';
  if (service.status_severity === 'crit') return 'bg-status-crit';
  if (service.status_severity === 'warn') return 'bg-status-warn';
  return 'bg-surface-600';
}
