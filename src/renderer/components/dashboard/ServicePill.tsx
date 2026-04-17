import type { ServiceHealth } from '@shared/types.js';

interface ServicePillProps {
  service: ServiceHealth;
}

export function ServicePill({ service }: ServicePillProps) {
  const dotColor = service.status_severity === 'good' ? 'bg-status-good' : service.status_severity === 'warn' ? 'bg-status-warn' : 'bg-status-crit';
  return (
    <div className="bg-surface-900 border border-surface-600 rounded-md p-2">
      <div className="flex items-center gap-1.5 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${dotColor}`}></span>
        <span className="font-semibold text-[11px] truncate">{service.display}</span>
      </div>
      <div className="text-[9.5px] text-text-secondary pl-3.5">
        {service.status}{service.start ? ` · ${service.start}` : ''}
      </div>
    </div>
  );
}
