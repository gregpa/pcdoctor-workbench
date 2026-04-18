import { useEffect, useState } from 'react';
import { api } from '@renderer/lib/ipc.js';

interface AuthEvent {
  time: string;
  event_id: number;
  account: string;
  source_ip: string;
  workstation: string;
  country?: string;
}

export function AuthEventsWidget() {
  const [events, setEvents] = useState<AuthEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const r = await (api as any).getRecentAuthEvents?.();
      if (!cancelled && r?.ok) {
        setEvents(r.data ?? []);
        setLoading(false);
      } else if (!cancelled) {
        setLoading(false);
      }
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <div className="bg-surface-800 border border-surface-600 rounded-lg p-3">
      <div className="text-[9.5px] uppercase tracking-wider text-text-secondary font-semibold mb-2">🔐 Auth Events (recent)</div>
      {loading ? (
        <div className="text-xs text-text-secondary">Loading…</div>
      ) : events.length === 0 ? (
        <div className="text-xs text-text-secondary">No failed logon events in recent window.</div>
      ) : (
        <div className="space-y-1 max-h-48 overflow-y-auto text-[11px]">
          {events.slice(0, 20).map((e, i) => (
            <div key={i} className="flex items-center gap-2 py-1 border-b border-surface-700 last:border-0">
              <span className="text-[9px] text-text-secondary shrink-0 w-12">{new Date(e.time).toLocaleTimeString().replace(/:\d\d\s/, ' ')}</span>
              <span className="text-[9px] px-1 rounded bg-status-crit/20 text-status-crit">{e.event_id}</span>
              <code className="text-[10px] truncate flex-1">{e.source_ip || e.workstation || '-'}</code>
              {e.country && <span className="text-[9px] text-text-secondary">{e.country}</span>}
              <span className="text-[9px] text-text-secondary truncate max-w-[80px]">{e.account}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
