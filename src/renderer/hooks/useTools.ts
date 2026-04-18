import { useEffect, useState, useCallback } from 'react';
import { api } from '@renderer/lib/ipc.js';
import type { ToolStatus } from '@shared/types.js';

export function useTools() {
  const [statuses, setStatuses] = useState<ToolStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const r = await api.listTools();
    if (r.ok) setStatuses(r.data);
    setLoading(false);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const launch = useCallback(async (id: string, modeId: string) => {
    return await api.launchTool(id, modeId);
  }, []);

  const install = useCallback(async (id: string): Promise<{ ok: boolean; message?: string }> => {
    setInstalling(prev => { const next = new Set(prev); next.add(id); return next; });
    try {
      const r = await api.installTool(id);
      if (!r.ok) return { ok: false, message: r.error.message };
      // Poll detection every 3s up to 2min
      for (let attempt = 0; attempt < 40; attempt++) {
        await new Promise(res => setTimeout(res, 3000));
        const fresh = await api.listTools();
        if (fresh.ok) {
          setStatuses(fresh.data);
          const s = fresh.data.find(x => x.id === id);
          if (s?.installed) return { ok: true };
        }
      }
      return { ok: false, message: 'Installed via winget but detection still failing — click Refresh' };
    } finally {
      setInstalling(prev => { const next = new Set(prev); next.delete(id); return next; });
    }
  }, []);

  const installAll = useCallback(async (): Promise<{ attempted: number; succeeded: number; failed: string[] }> => {
    const toInstall = statuses.filter(s => !s.installed);
    const failed: string[] = [];
    let succeeded = 0;
    // Sequential — winget doesn't handle concurrent installs well
    for (const s of toInstall) {
      const r = await install(s.id);
      if (r.ok) succeeded++;
      else failed.push(s.id);
    }
    return { attempted: toInstall.length, succeeded, failed };
  }, [statuses, install]);

  return { statuses, loading, installing, refresh, launch, install, installAll };
}
