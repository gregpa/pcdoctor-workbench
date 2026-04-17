import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { AuditLogEntry } from '@shared/types.js';

export function useHistory() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await api.getAuditLog(200);
    if (r.ok) setEntries(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const revert = useCallback(async (auditId: number) => {
    const r = await api.revertAction(auditId);
    await refresh();
    return r;
  }, [refresh]);

  return { entries, loading, refresh, revert };
}
