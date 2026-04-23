import type { ServiceHealth } from '@shared/types.js';

interface ServicePillProps {
  service: ServiceHealth;
  onClick?: (service: ServiceHealth) => void;
}

export function ServicePill({ service, onClick }: ServicePillProps) {
  // v2.4.8: dot color independent of status_severity.
  //
  // v2.4.7 first attempt used /run/i which matches the substring "run"
  // including inside "NOT RUNNING" and "running (2 procs)" alike — the NOT
  // case would still render green. Fixed via explicit status classification:
  //   - statuses the scanner actually emits (Invoke-PCDoctor.ps1):
  //       "Running"                       — Get-Service .Status
  //       "Stopped"                       — Get-Service .Status
  //       "StartPending" / "StopPending"  — Get-Service .Status (rare)
  //       "Paused"                        — Get-Service .Status (rare)
  //       "running (N procs)"             — Docker GUI hash emitter
  //       "NOT RUNNING"                   — Docker GUI hash emitter
  //       "service-running"               — Cloudflared emitter
  //       "service-stopped"/"service-paused"/"service-start pending"
  //       "process-running"               — Cloudflared emitter
  //       "OFFLINE"                       — Cloudflared (nothing running)
  //       "not_installed"                 — scanner (absent service)
  const s = (service.status || '').toLowerCase();
  // First: reject known "not running" variants. These strings contain the
  // substring "running" but represent a stopped/absent state, so the
  // running-regex below must be gated by !isNotRunning.
  //   MATCHES isNotRunning: "NOT RUNNING", "OFFLINE", "not_installed"
  const isNotRunning = s.includes('not running') || s === 'offline' || s === 'not_installed';
  // Second: detect actual running. Word boundary ensures we don't match
  // "not running" (blocked anyway by !isNotRunning) or other false positives.
  // The (^|-|\s) prefix permits the Cloudflared/Docker variants.
  //   MATCHES isRunning:    "Running", "running (3 procs)",
  //                         "service-running", "process-running"
  //   REJECTS:              "stopped", "StartPending", "service-stopped"
  const isRunning = !isNotRunning && /(^|-|\s)running\b/.test(s);
  // Third: detect stopped. Literal \bstopped\b catches "Stopped" and
  // "service-stopped". The OR-chain also covers the not_installed and
  // isNotRunning states so they flow into the stopped-colored branch.
  const isStopped = /\bstopped\b/.test(s) || s === 'not_installed' || isNotRunning;
  const stoppedAuto = isStopped && service.start === 'Automatic';
  const stoppedManual = isStopped && (service.start === 'Manual' || service.start === 'Disabled' || !service.start);
  const dotColor = isRunning
    ? 'bg-status-good'
    : stoppedAuto
      ? 'bg-status-crit'
      : stoppedManual
        ? 'bg-status-warn'
        : service.status_severity === 'crit'
          ? 'bg-status-crit'
          : service.status_severity === 'warn'
            ? 'bg-status-warn'
            : 'bg-surface-600';
  const clickable = !!onClick;
  const Wrapper: any = clickable ? 'button' : 'div';
  return (
    <Wrapper
      {...(clickable ? { onClick: () => onClick!(service), type: 'button' } : {})}
      className={`bg-surface-900 border border-surface-600 rounded-md p-2 text-left w-full ${clickable ? 'hover:border-status-info/40 cursor-pointer transition' : ''}`}
      title={clickable ? 'Click for actions' : undefined}
    >
      <div className="flex items-start gap-1.5 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${dotColor} flex-shrink-0 mt-1`}></span>
        {/* v2.4.39 (B45): service display name wraps to 2 lines instead of
            clipping to "S..." / "Wi..." on narrow tiles. Tooltip carries
            the full name on hover for extreme cases. min-w-0 is the
            flex-clip fix that lets break-words actually take effect on
            long compound identifiers like "DockerDesktopGUI". */}
        <span className="font-semibold text-[11px] break-words leading-tight min-w-0" title={service.display}>
          {service.display}
        </span>
      </div>
      <div className="text-[9.5px] text-text-secondary pl-3.5 break-words min-w-0">
        {service.status}{service.start ? ` · ${service.start}` : ''}
      </div>
    </Wrapper>
  );
}
