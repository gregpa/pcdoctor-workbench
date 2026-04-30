import type { ServiceHealth } from '@shared/types.js';
import { deriveServiceDotColor } from '@renderer/lib/serviceDotColor.js';

interface ServicePillProps {
  service: ServiceHealth;
  onClick?: (service: ServiceHealth) => void;
}

export function ServicePill({ service, onClick }: ServicePillProps) {
  // v2.5.10: extracted to deriveServiceDotColor so the modal header dot
  // uses the same logic. Pre-v2.5.10 the modal trusted backend
  // status_severity and rendered green for Stopped+Manual (BITS etc.)
  // while the tile rendered yellow — same service, different colors.
  const dotColor = deriveServiceDotColor(service);
  const clickable = !!onClick;
  const Wrapper: any = clickable ? 'button' : 'div';
  return (
    <Wrapper
      {...(clickable ? { onClick: () => onClick!(service), type: 'button' } : {})}
      className={`bg-surface-900 border border-surface-600 rounded-md p-2 text-left w-full ${clickable ? 'pcd-panel-interactive cursor-pointer transition-colors transition-shadow' : ''}`}
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
