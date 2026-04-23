/**
 * Renderer-side performance telemetry sink (v2.4.38).
 *
 * The renderer posts `phase + duration_ms + extra` records via
 * `ipcRenderer.send('api:logRenderPerf', ...)`. Main appends one JSON line
 * per record to `C:\ProgramData\PCDoctor\logs\render-perf-YYYYMMDD.log`.
 *
 * Why fire-and-forget: instrumentation must never affect the behavior it
 * measures. No awaiting, no responses, silent failure.
 *
 * Why a separate file from pcdoctorBridge's perf-YYYYMMDD.log:
 *   - main-process timings (getStatus, IPC) vs renderer timings (focus,
 *     mount, render) live in different columns and should be queryable
 *     separately. Mixing would confuse analysis.
 *
 * Purpose: v2.4.39 resize-freeze diagnosis. v2.4.37 locked the window as
 * a ship-blocker. Before we unlock, this infrastructure lets us capture
 * whatever's slow during resize drag without guessing.
 */
import { appendFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const RENDER_PERF_LOG_DIR = 'C:\\ProgramData\\PCDoctor\\logs';
// v2.4.38 (code-reviewer): soft size cap. Renderer-side throttling keeps
// normal cadence well under this, but a pathological storm (renderer bug
// dodging the throttle) should never fill the disk. Once the current
// day's log reaches the cap, writes are silently dropped and an in-memory
// counter tracks how many lines were lost -- visible to diagnostic tools
// via `getRenderPerfDroppedCount()` if we need to surface it later.
const MAX_LOG_BYTES = 50 * 1024 * 1024; // 50 MB

// v2.4.38 (code-reviewer): single-flight mkdir. Prior `_dirEnsured` bool
// could flip-flop if two concurrent calls hit a slow-disk mkdir. Shared
// Promise means everyone awaits the same in-flight resolution.
let _dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (_dirReady) return _dirReady;
  _dirReady = mkdir(RENDER_PERF_LOG_DIR, { recursive: true }).then(() => undefined);
  return _dirReady;
}

let _droppedSinceCap = 0;

function dayStamp(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Append a single JSON record to the renderer perf log. Fire-and-forget:
 * errors are swallowed so a stuck disk or missing dir never breaks the
 * caller. Silently drops writes once the day's log exceeds MAX_LOG_BYTES.
 */
export async function writeRenderPerfLine(
  phase: string,
  durationMs: number,
  extra?: Record<string, unknown>,
): Promise<void> {
  try {
    await ensureDir();
    const file = path.join(RENDER_PERF_LOG_DIR, `render-perf-${dayStamp()}.log`);
    try {
      const s = await stat(file);
      if (s.size >= MAX_LOG_BYTES) {
        _droppedSinceCap++;
        return;
      }
    } catch {
      /* stat fails on not-yet-created file; that's fine -- first write creates it */
    }
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      phase,
      duration_ms: Math.round(durationMs * 100) / 100,
      ...extra,
    }) + '\n';
    await appendFile(file, line, 'utf8');
  } catch {
    /* telemetry must never throw */
  }
}

/** Number of lines dropped because the day's log hit MAX_LOG_BYTES. */
export function getRenderPerfDroppedCount(): number {
  return _droppedSinceCap;
}
