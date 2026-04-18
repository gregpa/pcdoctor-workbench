import type { ReactNode } from 'react';

interface SecurityDetailModalProps {
  title: string;
  icon?: string;
  severity?: 'good' | 'warn' | 'crit';
  children: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}

export function SecurityDetailModal({ title, icon, severity, children, actions, onClose }: SecurityDetailModalProps) {
  const dotColor = severity === 'crit' ? 'bg-status-crit' : severity === 'warn' ? 'bg-status-warn' : 'bg-status-good';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="bg-surface-800 border border-surface-600 rounded-lg w-full max-w-lg p-5 shadow-2xl max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-base font-semibold mb-3 flex items-center gap-2">
          {severity && <span className={`w-2 h-2 rounded-full ${dotColor}`}></span>}
          {icon && <span>{icon}</span>}
          <span>{title}</span>
        </h2>
        <div className="text-sm text-text-secondary space-y-2 mb-4">
          {children}
        </div>
        <div className="flex justify-end gap-2 flex-wrap">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs bg-surface-700 border border-surface-600">
            Close
          </button>
          {actions}
        </div>
      </div>
    </div>
  );
}
