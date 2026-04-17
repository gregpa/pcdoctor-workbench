import type { WorkbenchApi } from '../../preload/preload.js';

declare global {
  interface Window {
    api: WorkbenchApi;
  }
}

export const api = window.api;

/** Throws if the IPC call returned an error. Use for cases where UI doesn't handle errors manually. */
export async function unwrap<T>(promise: Promise<{ ok: true; data: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await promise;
  if (r.ok) return r.data;
  throw Object.assign(new Error(r.error.message), { code: r.error.code });
}
