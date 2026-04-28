import { useEffect, useState } from 'react';
import { ACTIONS } from '@shared/actions.js';
import type { ActionName } from '@shared/types.js';

interface ApprovalRequest {
  id: string;
  action: string;
  params?: any;
  context?: string;
}

export function ClaudeApprovalListener() {
  const [pending, setPending] = useState<ApprovalRequest | null>(null);

  useEffect(() => {
    const unsubscribe = (window as any).api.onClaudeApprovalRequest((req: ApprovalRequest) => {
      setPending(req);
    });
    return unsubscribe;
  }, []);

  if (!pending) return null;
  const def = ACTIONS[pending.action as ActionName];

  function respond(approved: boolean) {
    (window as any).api.sendClaudeApproval(pending!.id, approved);
    setPending(null);
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4">
      <div className="bg-surface-800 border-2 border-status-warn/60 rounded-lg w-full max-w-md p-5 shadow-2xl">
        <div className="flex items-center gap-2 mb-3">
          <span className="text-2xl">🤖</span>
          <h2 className="text-base font-bold">Claude wants to run an action</h2>
        </div>
        <div className="bg-surface-900 border border-surface-600 rounded-md p-3 mb-3">
          <div className="text-sm font-bold">{def?.label ?? pending.action}</div>
          {def && <div className="text-xs text-text-secondary mt-1">{def.tooltip}</div>}
          {pending.params && (
            <div className="text-[11px] mt-2 text-text-secondary">
              <strong>Params:</strong> <code>{JSON.stringify(pending.params)}</code>
            </div>
          )}
          {pending.context && (
            <div className="text-[11px] mt-2 italic text-text-secondary">
              "{pending.context}"
            </div>
          )}
          {def && (
            <div className="text-[10px] text-text-secondary mt-2">
              Tier: {def.rollback_tier} · Est: ~{def.estimated_duration_s}s
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => respond(false)} className="px-3 py-1.5 rounded-md text-xs pcd-button">Reject</button>
          <button onClick={() => respond(true)} className="px-3 py-1.5 rounded-md text-xs bg-status-warn text-black font-bold">Approve</button>
        </div>
      </div>
    </div>
  );
}
