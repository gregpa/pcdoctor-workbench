/**
 * ServiceDetailModal (v2.4.25 - extracted from inline Dashboard modal)
 *
 * Opened when the user clicks a ServicePill tile on the Dashboard.
 * Shows the service's current status + metadata + offers Restart.
 *
 * Restart is the only service action currently wired through the
 * action pipeline (restart_service with ServiceName param). Stop /
 * Start could follow in future releases if / when those actions are
 * added to src/shared/actions.ts.
 */
import type { ServiceHealth } from '@shared/types.js';

export interface ServiceDetailModalProps {
  service: ServiceHealth;
  /** True when any action is currently running - disables the Restart button. */
  actionBusy: boolean;
  onClose: () => void;
  /** Caller invokes the restart_service action with the ServiceName param. */
  onRestart: (serviceKey: string) => void | Promise<void>;
}

function severityClass(s: ServiceHealth['status_severity']): string {
  switch (s) {
    case 'good': return 'bg-status-good';
    case 'warn': return 'bg-status-warn';
    case 'crit': return 'bg-status-crit';
  }
}

function explainSeverity(service: ServiceHealth): string {
  const status = (service.status || '').toLowerCase();
  const start = service.start ?? '';
  if (status.includes('running') && !status.includes('not')) return 'Service is running. Automatic services should stay in this state.';
  if (status === 'not_installed') return 'Service is not registered on this machine. May be expected (e.g. Docker optional) or a sign of a missing component.';
  if (status.includes('stopped') || status === 'offline' || status.includes('not running')) {
    if (start === 'Automatic') return 'Service is set to Automatic but currently stopped - likely a boot-time failure. Try Restart; if it fails repeatedly, check Event Log for crash details.';
    if (start === 'Manual' || start === 'Disabled') return 'Service is Manual / Disabled and not running. This is normal for on-demand services unless something you use depends on it.';
    return 'Service is stopped. Click Restart to bring it back up.';
  }
  if (status.includes('pending')) return 'Service is transitioning (StartPending / StopPending). Wait a few seconds and refresh the Dashboard.';
  if (status.includes('paused')) return 'Service is paused. Restart usually resumes normal operation.';
  return 'Status is unusual - Restart may resolve it, or check Event Log for recent service errors.';
}

export function ServiceDetailModal({ service, actionBusy, onClose, onRestart }: ServiceDetailModalProps) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${service.display} details`}
    >
      <div
        className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-md p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold mb-2 flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${severityClass(service.status_severity)}`}></span>
          <span>{service.display}</span>
        </h2>

        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px] mb-3">
          <span className="text-text-secondary">Service key</span>
          <span className="font-mono text-text-primary">{service.key}</span>

          <span className="text-text-secondary">Status</span>
          <span className="font-mono text-text-primary">{service.status}</span>

          <span className="text-text-secondary">Start type</span>
          <span className="font-mono text-text-primary">{service.start ?? '(unknown)'}</span>

          {service.detail && (
            <>
              <span className="text-text-secondary">Detail</span>
              <span className="text-text-primary">{service.detail}</span>
            </>
          )}
        </div>

        <div className="text-[11px] text-text-secondary leading-relaxed mb-4 p-2 rounded bg-surface-900/50 border border-surface-700">
          {explainSeverity(service)}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600"
          >
            Close
          </button>
          <button
            onClick={() => { void onRestart(service.key); }}
            disabled={actionBusy}
            className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-semibold disabled:opacity-50"
          >
            Restart Service
          </button>
        </div>
      </div>
    </div>
  );
}
