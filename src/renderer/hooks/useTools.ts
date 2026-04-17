import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ToolStatus } from '@shared/types.js';

export function useTools() {
  const [statuses, setStatuses] = useState<ToolStatus[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    const r = await api.listTools();
    if (r.ok) setStatuses(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const launch = useCallback(async (id: string, modeId: string) => {
    return await api.launchTool(id, modeId);
  }, []);

  const install = useCallback(async (id: string) => {
    const r = await api.installTool(id);
    await refresh();
    return r;
  }, [refresh]);

  return { statuses, loading, refresh, launch, install };
}
