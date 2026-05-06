/**
 * v2.5.30: TS-side dispatcher for the batched-UAC elevated worker.
 *
 * Sister of powershell/worker/Elevated-Worker.ps1. The worker is a long-
 * lived elevated PowerShell process that polls a file queue under
 * %LOCALAPPDATA%\PCDoctor\worker-queue\ for command files and writes
 * result files back. We can't pipe stdin across integrity levels (Windows
 * UIPI) so the file queue is the only reliable transport between an
 * unelevated Electron parent and an elevated child.
 *
 * Responsibilities:
 *   1. ensureWorkerRunning -- check heartbeat staleness, spawn via
 *      Start-Process -Verb RunAs if needed (this is THE UAC prompt).
 *   2. dispatchCommand -- write <id>.cmd.json, poll for <id>.result.json,
 *      parse + cleanup both files.
 *
 * Lifecycle:
 *   - First mutate call in a session triggers UAC.
 *   - Subsequent mutate calls reuse the running worker (no UAC).
 *   - Worker exits after IdleTimeoutSeconds (default 600s) of no commands.
 *   - Next mutate after that triggers UAC again. By design.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import log from 'electron-log/main.js';
import { resolveScriptPath } from './scriptRunner.js';
import { resolvePwshPath, PWSH_FALLBACK } from './constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** TS-side action allowlist. MUST match $ActionMap in Elevated-Worker.ps1. */
export const WORKER_ACTIONS = [
  'set-service-startup',
  'stop-service',
  'start-service',
  'restart-service',
  'kill-process',
  'set-process-priority',
  'set-process-affinity',
  'suspend-process',
  'resume-process',
] as const;

export type WorkerAction = (typeof WORKER_ACTIONS)[number];

/** Heartbeat is considered stale if older than this. */
const HEARTBEAT_STALE_MS = 30_000;
/** Max time to wait for the worker to come up after spawn. */
const WORKER_SPAWN_TIMEOUT_MS = 60_000;
/** Default per-command timeout. */
const DEFAULT_CMD_TIMEOUT_MS = 60_000;
/** Poll interval for result files. */
const RESULT_POLL_INTERVAL_MS = 100;
/** Poll interval for heartbeat after spawn. */
const HEARTBEAT_POLL_INTERVAL_MS = 250;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface WorkerHeartbeat {
  pid: number;
  started_at: number;
  last_seen: number;
  version: string;
}

export interface WorkerResultEnvelope<T = unknown> {
  id: string;
  duration_ms: number;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export class ElevatedWorkerError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ElevatedWorkerError';
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getQueueDir(): string {
  // process.env.LOCALAPPDATA is the canonical Windows location and is
  // identical for both unelevated and elevated processes within the same
  // user session, so both ends agree on the path.
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  return path.join(local, 'PCDoctor', 'worker-queue');
}

function ensureQueueDir(): string {
  const dir = getQueueDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getHeartbeatPath(): string {
  return path.join(getQueueDir(), '.heartbeat');
}

function getCmdPath(id: string): string {
  return path.join(getQueueDir(), `${id}.cmd.json`);
}

function getResultPath(id: string): string {
  return path.join(getQueueDir(), `${id}.result.json`);
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function readHeartbeat(): WorkerHeartbeat | null {
  const p = getHeartbeatPath();
  if (!existsSync(p)) return null;
  try {
    const raw = readFileSync(p, 'utf8');
    const obj = JSON.parse(raw) as WorkerHeartbeat;
    if (typeof obj.pid !== 'number' || typeof obj.last_seen !== 'number') return null;
    return obj;
  } catch {
    return null;
  }
}

export function isWorkerAlive(staleAfterMs: number = HEARTBEAT_STALE_MS): boolean {
  const hb = readHeartbeat();
  if (!hb) return false;
  return Date.now() - hb.last_seen < staleAfterMs;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Resolve the powershell base directory the worker should look under for
 * action scripts. Mirrors scriptRunner's resolveScriptPath logic but at
 * the directory level — the worker takes a -BasePath argument.
 */
function resolveBasePath(): string {
  // resolveScriptPath returns the canonical path for a relative script.
  // dirname('actions/X.ps1') = 'actions'; we want the parent of that.
  const probe = resolveScriptPath('actions/Restart-Service.ps1');
  // probe is something like C:\ProgramData\PCDoctor\actions\Restart-Service.ps1
  // OR <resources>\powershell\actions\Restart-Service.ps1. The base is two
  // path segments up.
  return path.dirname(path.dirname(probe));
}

/**
 * Fire-and-forget spawn of the elevated worker. UAC prompt fires HERE.
 * The launcher process exits immediately after invoking ShellExecute; the
 * elevated worker is reparented to PID 1 / system. Caller polls the
 * heartbeat file to know when the worker is up.
 *
 * Implementation: invoke an unelevated PowerShell that calls
 * `Start-Process -Verb RunAs powershell.exe ...` to escalate. The outer
 * powershell exits immediately; we don't track the elevated PID directly.
 */
/**
 * Build the launchCmd string passed to the unelevated PowerShell whose only
 * job is to invoke `Start-Process -Verb RunAs` to elevate the worker.
 *
 * v2.5.32: every token in -ArgumentList @(...) MUST be wrapped in single
 * quotes. PowerShell parses bare `-NoProfile` inside `@(...)` as the unary
 * minus operator and the whole expression fails with "Missing argument in
 * parameter list." -- which is what shipped from v2.5.30 to v2.5.31. The
 * outer PS exited before Start-Process ever ran, so UAC never fired.
 */
export function buildLaunchCmd(opts: {
  pwsh: string;
  workerScript: string;
  basePath: string;
  queueDir: string;
}): string {
  // PowerShell single-quote escape: '' inside single-quoted strings.
  const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const innerArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-File', opts.workerScript,
    '-BasePath', opts.basePath,
    '-QueueDir', opts.queueDir,
  ].map(q).join(',');
  return `Start-Process -FilePath ${q(opts.pwsh)} -ArgumentList @(${innerArgs}) -Verb RunAs -WindowStyle Hidden`;
}

async function spawnWorker(): Promise<void> {
  ensureQueueDir();
  const workerScript = resolveScriptPath('worker/Elevated-Worker.ps1');
  if (!existsSync(workerScript)) {
    throw new ElevatedWorkerError(
      'E_WORKER_SCRIPT_MISSING',
      `Elevated worker script not found at ${workerScript}`,
    );
  }
  const basePath = resolveBasePath();
  const queueDir = getQueueDir();
  const pwsh = existsSync(resolvePwshPath()) ? resolvePwshPath() : PWSH_FALLBACK;

  const launchCmd = buildLaunchCmd({ pwsh, workerScript, basePath, queueDir });

  log.info('[elevated-worker] spawning via UAC');
  const child = spawn(pwsh, [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden',
    '-Command', launchCmd,
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();

  // The launcher process resolves immediately after ShellExecute. We don't
  // wait for it -- success is signalled by the heartbeat file appearing.
}

/**
 * Ensure an elevated worker is running. Spawns one if the heartbeat is
 * missing or stale; waits up to WORKER_SPAWN_TIMEOUT_MS for the heartbeat
 * to appear after spawn. Returns once the worker is alive.
 *
 * @throws ElevatedWorkerError(E_WORKER_NO_HEARTBEAT) if heartbeat doesn't
 *   appear within the timeout (UAC dismissed OR worker crashed on startup).
 */
export async function ensureWorkerRunning(): Promise<void> {
  if (isWorkerAlive()) return;
  await spawnWorker();
  const deadline = Date.now() + WORKER_SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (isWorkerAlive(HEARTBEAT_STALE_MS)) return;
    await new Promise((r) => setTimeout(r, HEARTBEAT_POLL_INTERVAL_MS));
  }
  // Heartbeat never appeared. Two failure modes look identical from here:
  //   (1) UAC prompt was dismissed -- worker process never started
  //   (2) Worker process started but crashed before writing heartbeat
  //       (e.g. a PS startup error like the v2.5.30 $PID-shadowing bug)
  // The error message reflects both possibilities; main.log will show the
  // [elevated-worker] spawn entry either way, but only (2) leaves no
  // pwsh.exe / consent.exe trace.
  throw new ElevatedWorkerError(
    'E_WORKER_NO_HEARTBEAT',
    `Elevated worker did not write heartbeat within ${WORKER_SPAWN_TIMEOUT_MS / 1000}s. Either UAC was dismissed, or the worker crashed on startup. Check main.log.`,
  );
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

interface DispatchOpts {
  /** Per-command timeout. Default DEFAULT_CMD_TIMEOUT_MS (60s). */
  timeoutMs?: number;
}

/**
 * Send a command to the elevated worker and wait for the result. If the
 * worker isn't running, spawns it (UAC prompt). Throws on timeout, parse
 * error, or worker-reported failure.
 *
 * @throws ElevatedWorkerError with codes:
 *   - E_INVALID_ACTION       unknown action name
 *   - E_WORKER_NO_HEARTBEAT  worker spawn timed out (UAC denied OR crashed)
 *   - E_CMD_TIMEOUT          result file didn't appear within timeoutMs
 *   - E_BAD_RESULT      result file unparseable
 *   - <action's code>   action-specific error from the worker
 */
export async function dispatchCommand<T = unknown>(
  action: WorkerAction,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): Promise<WorkerResultEnvelope<T>> {
  if (!WORKER_ACTIONS.includes(action)) {
    throw new ElevatedWorkerError('E_INVALID_ACTION', `Unknown worker action: ${action}`);
  }
  await ensureWorkerRunning();

  const id = randomBytes(8).toString('hex');
  const cmdPath = getCmdPath(id);
  const resultPath = getResultPath(id);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;

  const cmdPayload = JSON.stringify({ id, action, params, ts: Date.now() });
  writeFileSync(cmdPath, cmdPayload, 'utf8');

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      // Read + parse + cleanup atomically (we own the id).
      let raw = '';
      try {
        raw = readFileSync(resultPath, 'utf8');
      } catch (e: any) {
        // Worker is mid-write; retry once after a short delay before giving up.
        await new Promise((r) => setTimeout(r, RESULT_POLL_INTERVAL_MS));
        try { raw = readFileSync(resultPath, 'utf8'); } catch {
          throw new ElevatedWorkerError('E_BAD_RESULT', `Could not read result file: ${e?.message ?? 'unknown'}`);
        }
      }
      try { rmSync(resultPath, { force: true }); } catch { /* best-effort */ }
      try { rmSync(cmdPath, { force: true }); } catch { /* worker should have removed it */ }
      try {
        return JSON.parse(raw) as WorkerResultEnvelope<T>;
      } catch (e: any) {
        throw new ElevatedWorkerError('E_BAD_RESULT', `Could not parse result JSON: ${e?.message ?? 'unknown'}`);
      }
    }
    await new Promise((r) => setTimeout(r, RESULT_POLL_INTERVAL_MS));
  }

  // Timeout. Best-effort cleanup of the cmd file so a slow worker doesn't
  // re-execute against stale state when it eventually catches up.
  try { rmSync(cmdPath, { force: true }); } catch { /* */ }
  throw new ElevatedWorkerError(
    'E_CMD_TIMEOUT',
    `Worker did not return a result for ${action} within ${timeoutMs}ms`,
  );
}

// ---------------------------------------------------------------------------
// Test-only exports
// ---------------------------------------------------------------------------

export const _testing = {
  HEARTBEAT_STALE_MS,
  WORKER_SPAWN_TIMEOUT_MS,
  DEFAULT_CMD_TIMEOUT_MS,
  resolveBasePath,
  getCmdPath,
  getResultPath,
};
