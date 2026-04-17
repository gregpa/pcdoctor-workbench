import type { ReactNode } from 'react';

interface TooltipProps {
  text: string;
  children: ReactNode;
}

export function Tooltip({ text, children }: TooltipProps) {
  return (
    <span className="relative group inline-flex">
      {children}
      <span
        role="tooltip"
        className="invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-opacity
                   absolute bottom-full left-1/2 -translate-x-1/2 mb-2
                   bg-surface-700 border border-status-info/50 text-text-primary
                   px-3 py-2 rounded-md text-xs font-normal leading-relaxed
                   min-w-[180px] max-w-[280px] w-max
                   shadow-lg pointer-events-none whitespace-normal z-50"
      >
        {text}
      </span>
    </span>
  );
}
