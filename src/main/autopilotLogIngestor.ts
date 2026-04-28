/**
 * autopilotLogIngestor (v2.4.45)
 *
 * Bridges Windows Scheduled Task runs into the autopilot_activity table so
 * the Autopilot page's LAST RUN column reflects scheduled runs. Without
 * this ingestor, scheduled tasks bypass actionRunner entirely and never
 * write to autopilot_activity -- the column is always "—" for schedule-
 * triggered rules.
 *
 * Pipeline:
 *   Task fires -> Run-AutopilotScheduled.ps1 dispatcher wraps action
 *   -> dispatcher appends JSON-Lines record to
 *        C:\ProgramData\PCDoctor\logs\autopilot-scheduled-YYYYMMDD.log
 *   -> this ingestor tails the file and inserts one activity row per line.
 *
 * Durability:
 *   - Byte-offset checkpoint at autopilot-scheduled-ingest.json (atomic
 *     write via .tmp + rename).
 *   - Single-flight: concurrent ingestOnce() calls await the existing one
 *     to avoid duplicate inserts.
 *   - Date rollover: drain prior day's file to EOF before advancing
 *     lastDate to today.
 *   - File-shrink detection (rotated / truncated log): reset offset to 0.
 *   - Partial last line (writer mid-append): stop at the last '\n', carry
 *     the partial over to the next pass.
 *   - Per-line errors (bad JSON, db constraint): logged once, skipped; the
 *     whole batch never fails.
 *
 * Cadence:
 *   - Immediate drain 5s after startup (pick up anything while app was
 *     shut down).
 *   - Re-drain every 5 minutes so open Autopilot pages see new runs
 *     without requiring a window focus / manual refresh.
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { insertAutopilotActivity } from './dataStore.js';

// Paths are `let` so tests can redirect them to a temp dir via
// _autopilotIngestorTestHooks.setPathsForTests. Production code never
// writes to these bindings after module load.
let LOGS_DIR = 'C:\\ProgramData\\PCDoctor\\logs';
let CHECKPOINT_PATH = path.join(LOGS_DIR, 'autopilot-scheduled-ingest.json');
const INGEST_INTERVAL_MS = 5 * 60 * 1000;
const INITIAL_DELAY_MS = 5_000;

const VALID_OUTCOMES = new Set([
  'auto_run',
  'alerted',
  'suppressed',
  'skipped',
  'error',
]);

interface Checkpoint {
  lastDate: string; // YYYYMMDD
  lastOffset: number;
}

export interface ParsedAutopilotLine {
  ts: number;
  rule_id: string;
  tier: 1 | 2 | 3;
  outcome: 'auto_run' | 'alerted' | 'suppressed' | 'skipped' | 'error';
  action_name?: string | null;
  duration_ms?: number;
  message?: string;
  bytes_freed?: number;
}

let _timer: NodeJS.Timeout | null = null;
let _initialTimer: NodeJS.Timeout | null = null;
let _inFlight: Promise<void> | null = null;
let _warnedOncePerDate = new Set<string>();

function dayStamp(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function logFileForDate(dateStr: string): string {
  return path.join(LOGS_DIR, `autopilot-scheduled-${dateStr}.log`);
}

/**
 * Pure parser. Accepts a single JSON-Lines record string, returns a row
 * ready for insertAutopilotActivity, or null if the line is malformed or
 * missing required fields. Never throws.
 */
export function parseAutopilotLogLine(line: string): ParsedAutopilotLine | null {
  const trimmed = line.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const r = obj as Record<string, unknown>;

  const tsIso = r.ts;
  if (typeof tsIso !== 'string') return null;
  const tsMs = Date.parse(tsIso);
  if (!Number.isFinite(tsMs)) return null;

  const ruleId = r.rule_id;
  if (typeof ruleId !== 'string' || !ruleId) return null;

  const tierRaw = r.tier;
  if (tierRaw !== 1 && tierRaw !== 2 && tierRaw !== 3) return null;

  const outcomeRaw = r.outcome;
  if (typeof outcomeRaw !== 'string' || !VALID_OUTCOMES.has(outcomeRaw)) return null;

  const row: ParsedAutopilotLine = {
    ts: tsMs,
    rule_id: ruleId,
    tier: tierRaw,
    outcome: outcomeRaw as ParsedAutopilotLine['outcome'],
  };

  if (typeof r.action_name === 'string') row.action_name = r.action_name;
  if (typeof r.duration_ms === 'number' && Number.isFinite(r.duration_ms)) {
    row.duration_ms = Math.max(0, Math.round(r.duration_ms));
  }
  if (typeof r.message === 'string') row.message = r.message;
  if (typeof r.bytes_freed === 'number' && Number.isFinite(r.bytes_freed)) {
    row.bytes_freed = Math.max(0, Math.round(r.bytes_freed));
  }

  return row;
}

async function readCheckpoint(): Promise<Checkpoint> {
  try {
    const txt = await fsp.readFile(CHECKPOINT_PATH, 'utf8');
    const obj = JSON.parse(txt) as unknown;
    if (
      obj && typeof obj === 'object' && !Array.isArray(obj) &&
      typeof (obj as Checkpoint).lastDate === 'string' &&
      /^\d{8}$/.test((obj as Checkpoint).lastDate) &&
      typeof (obj as Checkpoint).lastOffset === 'number' &&
      (obj as Checkpoint).lastOffset >= 0
    ) {
      return obj as Checkpoint;
    }
  } catch {
    /* first boot, corrupt file, or missing logs dir -- start fresh */
  }
  return { lastDate: dayStamp(), lastOffset: 0 };
}

async function writeCheckpoint(cp: Checkpoint): Promise<void> {
  try {
    await fsp.mkdir(LOGS_DIR, { recursive: true });
  } catch {
    /* non-fatal; writeFile below will surface the real error */
  }
  const tmp = CHECKPOINT_PATH + '.tmp';
  const txt = JSON.stringify(cp);
  await fsp.writeFile(tmp, txt, 'utf8');
  await fsp.rename(tmp, CHECKPOINT_PATH);
}

/**
 * Read `file` starting at `startOffset`, insert activity rows for each
 * complete line, and return the new byte offset (just past the last '\n'
 * we consumed). If the file is missing or shorter than startOffset, returns
 * 0 (caller should reset checkpoint).
 *
 * Bounded by EOF-at-open-time (not current EOF): concurrent appends after
 * the stat call are picked up on the next pass. Prevents racing the
 * dispatcher's retry window.
 */
async function ingestFileFromOffset(file: string, startOffset: number): Promise<number> {
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    stat = await fsp.stat(file);
  } catch {
    return startOffset; // file doesn't exist yet; keep offset unchanged
  }

  if (stat.size < startOffset) {
    // File shrank (rotated, truncated, or checkpoint stale). Reset.
    startOffset = 0;
  }
  if (stat.size === startOffset) return startOffset;

  const len = stat.size - startOffset;
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, startOffset);
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl < 0) {
      // No complete line yet; come back next pass.
      return startOffset;
    }
    const complete = text.slice(0, lastNl + 1);

    // v2.4.51 (B51-LOG-1): track byte cursor of LAST successful insert so a
    // failed insert halts cursor advance. Pre-2.4.51 the cursor advanced past
    // the failed line and the row was permanently lost on the next pass.
    // Tradeoff: a deterministic insert-failing line will block ingest forever
    // — strictly better than silently dropping data; warn-once-per-day
    // surfaces a chronically-broken DB.
    //
    // `complete` ends in '\n' (the lastNl boundary). Splitting on '\n'
    // therefore gives N actual lines plus one trailing empty string we
    // discard with .slice(0, -1) — every kept element corresponds to a real
    // line whose terminating '\n' contributes the +1 to lineBytes.
    const lines = complete.split('\n').slice(0, -1);
    let cursor = startOffset;
    let lastGoodCursor = startOffset;
    let halted = false;
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line + '\n', 'utf8');
      cursor += lineBytes;
      if (!line.trim()) {
        // Empty line — not a failed insert, advance unconditionally.
        lastGoodCursor = cursor;
        continue;
      }
      const parsed = parseAutopilotLogLine(line);
      if (!parsed) {
        // Malformed line — not retryable; advance past it (matches
        // pre-2.4.51 behavior; only insert failures halt the cursor).
        lastGoodCursor = cursor;
        continue;
      }
      try {
        insertAutopilotActivity({
          rule_id: parsed.rule_id,
          tier: parsed.tier,
          action_name: parsed.action_name ?? null,
          outcome: parsed.outcome,
          bytes_freed: parsed.bytes_freed,
          duration_ms: parsed.duration_ms,
          message: parsed.message,
          ts: parsed.ts,
        });
        lastGoodCursor = cursor;
      } catch (err) {
        // v2.4.51 (B51-LOG-1): db insert failed (corrupt db, FK, shutdown).
        // STOP advancing the cursor here. The next ingestOnce() pass will
        // re-attempt this line and every subsequent line. Pre-2.4.51 the
        // cursor advanced past the failed line and the row was permanently
        // lost.
        const today = dayStamp();
        if (!_warnedOncePerDate.has(today)) {
          _warnedOncePerDate.add(today);
          console.warn('[autopilotLogIngestor] insert failed; halting cursor advance:', err instanceof Error ? err.message : String(err));
        }
        halted = true;
        break;  // do not advance past a failed insert
      }
    }
    // When no insert failed, the cursor walk finishes at startOffset +
    // Buffer.byteLength(complete), preserving the prior return semantics
    // (offset advances past every consumed line). When halted, lastGoodCursor
    // sits at the byte just past the last successfully-inserted line.
    return halted ? lastGoodCursor : (startOffset + Buffer.byteLength(complete, 'utf8'));
  } finally {
    await fh.close();
  }
}

/**
 * One full drain pass. Safe to call concurrently -- the second caller awaits
 * the first's in-flight Promise.
 */
export async function ingestOnce(): Promise<void> {
  if (_inFlight) return _inFlight;
  _inFlight = (async () => {
    try {
      const cp = await readCheckpoint();
      const today = dayStamp();

      // Date-rollover: drain prior day to EOF before advancing.
      let nextDate = cp.lastDate;
      let nextOffset = cp.lastOffset;
      if (cp.lastDate !== today) {
        const priorFile = logFileForDate(cp.lastDate);
        try {
          const finalOffset = await ingestFileFromOffset(priorFile, cp.lastOffset);
          // Code-reviewer W4: persist intermediate state UNCONDITIONALLY
          // before rolling the day. Even if finalOffset === cp.lastOffset
          // (no new lines visible on prior-day file this pass), we still
          // write the checkpoint so that any row that WAS inserted by an
          // earlier partial pass and whose error we swallowed can't be
          // double-inserted after rollover.
          await writeCheckpoint({ lastDate: cp.lastDate, lastOffset: finalOffset });
        } catch {
          /* ignore; will retry next pass */
        }
        nextDate = today;
        nextOffset = 0;
      }

      const todayFile = logFileForDate(today);
      try {
        nextOffset = await ingestFileFromOffset(todayFile, nextOffset);
      } catch {
        /* ignore transient read errors */
      }

      if (nextDate !== cp.lastDate || nextOffset !== cp.lastOffset) {
        await writeCheckpoint({ lastDate: nextDate, lastOffset: nextOffset });
      }
    } finally {
      _inFlight = null;
    }
  })();
  return _inFlight;
}

/**
 * Begin periodic ingestion. Idempotent -- calling twice is a no-op.
 * Scheduled from main.ts after app.whenReady().
 */
export function startAutopilotLogIngestor(): void {
  if (_timer || _initialTimer) return;
  _initialTimer = setTimeout(() => {
    _initialTimer = null;
    ingestOnce().catch(() => {});
  }, INITIAL_DELAY_MS);
  _timer = setInterval(() => {
    ingestOnce().catch(() => {});
  }, INGEST_INTERVAL_MS);
  // Don't keep the event loop alive just for this interval; the app's
  // main window + poll timers handle liveness.
  _timer.unref?.();
  _initialTimer.unref?.();
}

/**
 * Stop the ingestor (called on app quit + from tests). Async so callers
 * can await the in-flight drain before the process exits -- otherwise a
 * timer-triggered ingestOnce() mid-execution could still call into
 * better-sqlite3 after the db is closed, silently dropping rows and
 * advancing the checkpoint past them. Code-reviewer W3 (v2.4.45).
 */
export async function stopAutopilotLogIngestor(): Promise<void> {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_initialTimer) { clearTimeout(_initialTimer); _initialTimer = null; }
  const pending = _inFlight;
  if (pending) {
    try { await pending; } catch { /* already swallowed inside the promise */ }
  }
  _inFlight = null;
}

/** Test hooks -- not part of the public surface. */
export const _autopilotIngestorTestHooks = {
  ingestFileFromOffset,
  readCheckpoint,
  writeCheckpoint,
  ingestOnce,
  dayStamp,
  logFileForDate,
  resetWarnings: () => { _warnedOncePerDate = new Set<string>(); },
  getCheckpointPath: () => CHECKPOINT_PATH,
  getLogsDir: () => LOGS_DIR,
  setPathsForTests(logsDir: string, checkpointPath: string) {
    LOGS_DIR = logsDir;
    CHECKPOINT_PATH = checkpointPath;
  },
  resetInFlight: () => { _inFlight = null; },
};
