/**
 * Module: diagnose-worker-terminate-copyfile.mjs
 * Purpose: Decide whether PCDoctor can safely isolate stuck Windows CopyFileW
 *          reads with worker.terminate(), or must use a killable child process.
 * Dependencies: Node built-ins only. PowerShell creates Windows file-sharing
 *               locks because Node does not expose FileShare flags. Sysinternals
 *               handle.exe/handle64.exe is optional and used only for evidence.
 * Used by: Manual forensic runs from the repo root:
 *          node scripts/diagnose-worker-terminate-copyfile.mjs --iterations 50
 * Key decisions: This is a standalone diagnostic harness, not app runtime code.
 *                The parent process owns cleanup and hard-kills probe children
 *                so a failed worker.terminate() cannot wedge the harness itself.
 */

import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const DEFAULT_ITERATIONS = 50;
const DEFAULT_TERMINATE_AFTER_MS = 3_000;
const DEFAULT_POST_TERMINATE_OBSERVE_MS = 1_000;
const LOCK_HOLD_SECONDS = 30;
const CHILD_START_TIMEOUT_MS = 5_000;
const CHILD_EXIT_TIMEOUT_MS = 5_000;
const HANDLE_TIMEOUT_MS = 5_000;
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const workerSource = `
  const { parentPort } = require('node:worker_threads');
  const { copyFile } = require('node:fs/promises');

  parentPort.on('message', async ({ src, dst }) => {
    parentPort.postMessage({ event: 'copy_start', ts: Date.now() });
    try {
      await copyFile(src, dst);
      parentPort.postMessage({ event: 'copy_done', ts: Date.now() });
    } catch (error) {
      parentPort.postMessage({
        event: 'copy_error',
        ts: Date.now(),
        code: error && error.code,
        message: error && error.message,
      });
    }
  });
`;

function parseArgs(argv) {
  const args = {
    iterations: DEFAULT_ITERATIONS,
    terminateAfterMs: DEFAULT_TERMINATE_AFTER_MS,
    observeAfterTerminateMs: DEFAULT_POST_TERMINATE_OBSERVE_MS,
    handleExe: process.env.PCD_HANDLE_EXE || '',
    keepArtifacts: false,
    shareModes: ['Read', 'None'],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--iterations' && next) {
      args.iterations = Number(next);
      i += 1;
    } else if (arg === '--terminate-ms' && next) {
      args.terminateAfterMs = Number(next);
      i += 1;
    } else if (arg === '--observe-ms' && next) {
      args.observeAfterTerminateMs = Number(next);
      i += 1;
    } else if (arg === '--handle-exe' && next) {
      args.handleExe = next;
      i += 1;
    } else if (arg === '--share-mode' && next) {
      args.shareModes = next.split(',').map((s) => s.trim()).filter(Boolean);
      i += 1;
    } else if (arg === '--keep-artifacts') {
      args.keepArtifacts = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isInteger(args.iterations) || args.iterations < 1) {
    throw new Error('--iterations must be a positive integer');
  }
  if (!Number.isFinite(args.terminateAfterMs) || args.terminateAfterMs < 1) {
    throw new Error('--terminate-ms must be a positive number');
  }
  if (!Number.isFinite(args.observeAfterTerminateMs) || args.observeAfterTerminateMs < 1) {
    throw new Error('--observe-ms must be a positive number');
  }
  for (const mode of args.shareModes) {
    if (!['Read', 'None'].includes(mode)) {
      throw new Error('--share-mode accepts Read, None, or Read,None');
    }
  }

  return args;
}

function printHelpAndExit() {
  console.log(`Usage:
  node scripts/diagnose-worker-terminate-copyfile.mjs [options]

Options:
  --iterations <n>      Probe repetitions per isolation primitive and share mode.
                        Default: ${DEFAULT_ITERATIONS}
  --terminate-ms <n>    Delay before worker.terminate() / child.kill('SIGKILL').
                        Default: ${DEFAULT_TERMINATE_AFTER_MS}
  --observe-ms <n>      Post-terminate observation window before hard cleanup.
                        Default: ${DEFAULT_POST_TERMINATE_OBSERVE_MS}
  --handle-exe <path>   Optional Sysinternals handle.exe/handle64.exe.
                        Also read from PCD_HANDLE_EXE.
  --share-mode <modes>  Read, None, or Read,None. Default: Read,None
  --keep-artifacts      Leave the temp directory behind.

Notes:
  FileShare.Read is the exact proposed probe, but it usually allows source reads.
  FileShare.None is the stronger exclusive-lock reproduction of a blocked open.
`);
  process.exit(0);
}

function emitChildEvent(event) {
  process.stdout.write(`${JSON.stringify({ ...event, ts: Date.now(), pid: process.pid })}\n`);
}

async function workerProbeChildMain([src, dst, terminateAfterMsRaw]) {
  const terminateAfterMs = Number(terminateAfterMsRaw);
  emitChildEvent({ event: 'child_ready', primitive: 'worker' });

  const worker = new Worker(workerSource, { eval: true });
  worker.on('message', (message) => {
    emitChildEvent({ event: 'worker_message', message });
    if (message && (message.event === 'copy_done' || message.event === 'copy_error')) {
      process.exitCode = message.event === 'copy_done' ? 0 : 2;
      setTimeout(() => process.exit(process.exitCode), 0);
    }
  });
  worker.on('error', (error) => emitChildEvent({
    event: 'worker_error',
    code: error.code,
    message: error.message,
  }));
  worker.on('exit', (code) => emitChildEvent({ event: 'worker_exit', code }));

  worker.postMessage({ src, dst });
  emitChildEvent({ event: 'worker_posted' });

  setTimeout(async () => {
    emitChildEvent({ event: 'terminate_begin' });
    try {
      const code = await worker.terminate();
      emitChildEvent({ event: 'terminate_resolved', code });
      process.exitCode = 0;
    } catch (error) {
      emitChildEvent({ event: 'terminate_error', code: error.code, message: error.message });
      process.exitCode = 2;
    }
  }, terminateAfterMs);
}

async function forkProbeChildMain([src, dst]) {
  emitChildEvent({ event: 'child_ready', primitive: 'fork' });
  emitChildEvent({ event: 'copy_start' });
  try {
    await copyFile(src, dst);
    emitChildEvent({ event: 'copy_done' });
  } catch (error) {
    emitChildEvent({ event: 'copy_error', code: error.code, message: error.message });
    process.exitCode = 2;
  }
}

function nowMs() {
  return performance.now();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundMs(value) {
  return Math.round(value * 100) / 100;
}

async function fileInfo(filePath) {
  try {
    const s = await stat(filePath);
    return { exists: true, bytes: s.size };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { exists: false, bytes: 0 };
    return { exists: false, bytes: 0, error: error && error.message };
  }
}

function spawnJsonChild(args) {
  const child = spawn(process.execPath, [SCRIPT_PATH, ...args], { windowsHide: true });
  const events = [];
  const waiters = [];
  let stdoutBuffer = '';
  let stderr = '';

  const notify = () => {
    for (const waiter of [...waiters]) {
      const found = events.find(waiter.predicate);
      if (found) {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    }
  };

  child.stdout.on('data', (buf) => {
    stdoutBuffer += String(buf);
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        events.push({ event: 'unparsed_stdout', line });
      }
    }
    notify();
  });
  child.stderr.on('data', (buf) => { stderr += String(buf); });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  return {
    child,
    events,
    get stderr() { return stderr; },
    exited,
    waitFor(predicate, timeoutMs) {
      const found = events.find(predicate);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error(`Timed out waiting for child event after ${timeoutMs} ms`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function waitForExitOrTimeout(childHandle, timeoutMs) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const result = await Promise.race([childHandle.exited, timeout]);
  if (timer) clearTimeout(timer);
  return result;
}

async function killAndWait(child, signal = 'SIGKILL') {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return { alreadyExited: true };
  }
  const start = nowMs();
  child.kill(signal);
  const exit = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), CHILD_EXIT_TIMEOUT_MS);
    child.once('exit', (code, sig) => {
      clearTimeout(timer);
      resolve({ code, signal: sig, elapsed_ms: roundMs(nowMs() - start) });
    });
  });
  return exit || { timedOut: true };
}

async function runCommand(command, args, timeoutMs) {
  const child = spawn(command, args, { windowsHide: true });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += String(buf); });
  child.stderr.on('data', (buf) => { stderr += String(buf); });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, timeoutMs);

  const exit = await new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timer);
  return { stdout, stderr, exit, timedOut };
}

async function inspectHandles(handleExe, pid, filePath) {
  if (!handleExe) return { available: false, reason: 'handle.exe not configured' };
  const result = await runCommand(handleExe, [
    '-accepteula',
    '-nobanner',
    '-p',
    String(pid),
    filePath,
  ], HANDLE_TIMEOUT_MS);
  const haystack = `${result.stdout}\n${result.stderr}`.toLowerCase();
  const normalizedPath = filePath.toLowerCase();
  return {
    available: true,
    matched_source_path: haystack.includes(normalizedPath),
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    exit: result.exit,
    timedOut: result.timedOut,
  };
}

async function startLockHolder(filePath, shareMode) {
  const scriptBody = [
    'param([string]$Path, [string]$ShareMode, [int]$Seconds)',
    '$ErrorActionPreference = "Stop"',
    '$share = [System.IO.FileShare]::$ShareMode',
    '$fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, $share)',
    'try {',
    '  [Console]::Out.WriteLine("READY")',
    '  Start-Sleep -Seconds $Seconds',
    '} finally {',
    '  $fs.Dispose()',
    '}',
  ].join('; ');
  const script = `& { ${scriptBody} }`;
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
    filePath,
    shareMode,
    String(LOCK_HOLD_SECONDS),
  ], { windowsHide: true });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (buf) => { stdout += String(buf); });
  child.stderr.on('data', (buf) => { stderr += String(buf); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Lock holder did not become ready. stderr=${stderr.trim()}`));
    }, CHILD_START_TIMEOUT_MS);
    child.stdout.on('data', () => {
      if (stdout.includes('READY')) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Lock holder exited early with code ${code}. stderr=${stderr.trim()}`));
    });
  });

  return {
    pid: child.pid,
    async stop() {
      const result = await killAndWait(child, 'SIGKILL');
      return result;
    },
  };
}

async function createProbeFile(filePath, iteration, shareMode) {
  const body = {
    probe: 'pcdoctor-copyfile-termination',
    iteration,
    shareMode,
    ts: new Date().toISOString(),
  };
  await writeFile(filePath, JSON.stringify(body, null, 2), 'utf8');
}

async function runWorkerIteration({ rootDir, iteration, shareMode, terminateAfterMs, observeAfterTerminateMs, handleExe }) {
  const src = path.join(rootDir, `worker-${shareMode}-${iteration}.json`);
  const dst = path.join(rootDir, `worker-${shareMode}-${iteration}.copy.json`);
  await createProbeFile(src, iteration, shareMode);
  const lock = await startLockHolder(src, shareMode);
  const probeStarted = nowMs();
  const childHandle = spawnJsonChild(['--worker-probe-child', src, dst, String(terminateAfterMs)]);

  try {
    await childHandle.waitFor((e) => e.event === 'child_ready', CHILD_START_TIMEOUT_MS);
    await sleep(100);
    const beforeTerminateHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    const preExit = await waitForExitOrTimeout(childHandle, 0);
    if (preExit) {
      return buildIterationResult({
        primitive: 'worker',
        shareMode,
        iteration,
        probeStarted,
        childHandle,
        lock,
        dst,
        beforeTerminateHandles,
        afterTerminateHandles: null,
        afterObserveHandles: null,
        exitBeforeCleanup: preExit,
        cleanupKill: { alreadyExited: true },
      });
    }

    await childHandle.waitFor((e) => e.event === 'terminate_begin', terminateAfterMs + CHILD_START_TIMEOUT_MS);
    await sleep(100);
    const afterTerminateHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    await sleep(observeAfterTerminateMs);
    const afterObserveHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    const exitBeforeCleanup = await waitForExitOrTimeout(childHandle, 0);
    const cleanupKill = exitBeforeCleanup ? { alreadyExited: true } : await killAndWait(childHandle.child, 'SIGKILL');

    return buildIterationResult({
      primitive: 'worker',
      shareMode,
      iteration,
      probeStarted,
      childHandle,
      lock,
      dst,
      beforeTerminateHandles,
      afterTerminateHandles,
      afterObserveHandles,
      exitBeforeCleanup,
      cleanupKill,
    });
  } finally {
    await lock.stop();
  }
}

async function runForkIteration({ rootDir, iteration, shareMode, terminateAfterMs, observeAfterTerminateMs, handleExe }) {
  const src = path.join(rootDir, `fork-${shareMode}-${iteration}.json`);
  const dst = path.join(rootDir, `fork-${shareMode}-${iteration}.copy.json`);
  await createProbeFile(src, iteration, shareMode);
  const lock = await startLockHolder(src, shareMode);
  const probeStarted = nowMs();
  const childHandle = spawnJsonChild(['--fork-probe-child', src, dst]);

  try {
    await childHandle.waitFor((e) => e.event === 'child_ready', CHILD_START_TIMEOUT_MS);
    await sleep(100);
    const beforeTerminateHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    const preExit = await waitForExitOrTimeout(childHandle, 0);
    if (preExit) {
      return buildIterationResult({
        primitive: 'fork',
        shareMode,
        iteration,
        probeStarted,
        childHandle,
        lock,
        dst,
        beforeTerminateHandles,
        afterTerminateHandles: null,
        afterObserveHandles: null,
        exitBeforeCleanup: preExit,
        cleanupKill: { alreadyExited: true },
      });
    }

    await sleep(terminateAfterMs);
    const killStarted = nowMs();
    childHandle.child.kill('SIGKILL');
    await sleep(100);
    const afterTerminateHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    const exitAfterKill = await waitForExitOrTimeout(childHandle, observeAfterTerminateMs);
    const afterObserveHandles = await inspectHandles(handleExe, childHandle.child.pid, src);
    const cleanupKill = exitAfterKill
      ? { alreadyExited: true, elapsed_ms: roundMs(nowMs() - killStarted), exit: exitAfterKill }
      : await killAndWait(childHandle.child, 'SIGKILL');

    return buildIterationResult({
      primitive: 'fork',
      shareMode,
      iteration,
      probeStarted,
      childHandle,
      lock,
      dst,
      beforeTerminateHandles,
      afterTerminateHandles,
      afterObserveHandles,
      exitBeforeCleanup: exitAfterKill,
      cleanupKill,
    });
  } finally {
    await lock.stop();
  }
}

async function buildIterationResult({
  primitive,
  shareMode,
  iteration,
  probeStarted,
  childHandle,
  lock,
  dst,
  beforeTerminateHandles,
  afterTerminateHandles,
  afterObserveHandles,
  exitBeforeCleanup,
  cleanupKill,
}) {
  const destination = await fileInfo(dst);
  const events = childHandle.events;
  const result = {
    primitive,
    shareMode,
    iteration,
    child_pid: childHandle.child.pid,
    lock_pid: lock.pid,
    elapsed_ms: roundMs(nowMs() - probeStarted),
    outcome: classifyOutcome({ primitive, shareMode, events, exitBeforeCleanup, cleanupKill, destination }),
    destination,
    events,
    beforeTerminateHandles,
    afterTerminateHandles,
    afterObserveHandles,
    exitBeforeCleanup,
    cleanupKill,
    stderr: childHandle.stderr.trim(),
  };
  return result;
}

function classifyOutcome({ primitive, events, exitBeforeCleanup, cleanupKill, destination }) {
  const copyDone = events.some((e) => e.event === 'copy_done' || e.message?.event === 'copy_done');
  const copyError = events.find((e) => e.event === 'copy_error' || e.message?.event === 'copy_error');
  const terminateResolved = events.some((e) => e.event === 'terminate_resolved');

  if (copyDone) return 'copy_completed_before_or_during_termination';
  if (copyError) return 'copy_failed_fast';

  if (primitive === 'worker') {
    if (terminateResolved && exitBeforeCleanup) return 'worker_terminate_clean';
    if (terminateResolved && !exitBeforeCleanup) return 'worker_terminate_resolved_but_process_lingered';
    if (cleanupKill && cleanupKill.alreadyExited) return 'worker_exited_without_cleanup_kill';
    return 'worker_terminate_did_not_resolve';
  }

  if (primitive === 'fork') {
    if (exitBeforeCleanup) return 'process_kill_clean';
    return 'process_kill_did_not_exit';
  }

  if (destination.exists) return 'unexpected_destination_created';
  return 'unknown';
}

function summarize(results) {
  const groups = new Map();
  for (const result of results) {
    const key = `${result.primitive}/${result.shareMode}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(result);
  }

  const summary = [];
  for (const [key, rows] of groups) {
    const [primitive, shareMode] = key.split('/');
    const outcomes = {};
    for (const row of rows) outcomes[row.outcome] = (outcomes[row.outcome] || 0) + 1;
    const handleMatchesAfterObserve = rows.filter((row) => row.afterObserveHandles?.matched_source_path).length;
    summary.push({
      primitive,
      shareMode,
      iterations: rows.length,
      outcomes,
      handleMatchesAfterObserve,
      decision: decideGroup({ primitive, shareMode, outcomes, rows }),
    });
  }
  return summary;
}

function decideGroup({ primitive, shareMode, outcomes, rows }) {
  if (shareMode === 'Read' && outcomes.copy_completed_before_or_during_termination === rows.length) {
    return 'Does not reproduce a blocked source read; FileShare.Read allows copyFile to read.';
  }
  if (primitive === 'worker') {
    if (outcomes.worker_terminate_clean === rows.length) {
      return 'Worker terminate is clean for this probe.';
    }
    if (outcomes.worker_terminate_did_not_resolve) {
      return 'Worker terminate is not a safe timeout boundary for this blocked CopyFileW probe.';
    }
    return 'Mixed worker result; do not ship worker isolation without more investigation.';
  }
  if (primitive === 'fork') {
    if (outcomes.process_kill_clean === rows.length) {
      return 'Child process kill is a clean timeout boundary for this probe.';
    }
    return 'Mixed child-process result; investigate before relying on fork isolation.';
  }
  return 'No decision.';
}

function printProgress(result) {
  console.log([
    `iter=${result.iteration}`,
    `primitive=${result.primitive}`,
    `share=${result.shareMode}`,
    `outcome=${result.outcome}`,
    `elapsed=${result.elapsed_ms}ms`,
  ].join(' '));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.join(os.tmpdir(), `pcd-copyfile-termination-${Date.now()}`);
  await mkdir(rootDir, { recursive: true });
  const results = [];

  console.log(`Diagnostic temp dir: ${rootDir}`);
  console.log(`Iterations per group: ${args.iterations}`);
  console.log(`Terminate after: ${args.terminateAfterMs} ms`);
  console.log(`Post-terminate observation: ${args.observeAfterTerminateMs} ms`);
  console.log(`Share modes: ${args.shareModes.join(', ')}`);
  console.log(`handle.exe: ${args.handleExe || 'not configured; handle snapshots skipped'}`);

  try {
    for (const shareMode of args.shareModes) {
      for (let iteration = 1; iteration <= args.iterations; iteration += 1) {
        const workerResult = await runWorkerIteration({
          rootDir,
          iteration,
          shareMode,
          terminateAfterMs: args.terminateAfterMs,
          observeAfterTerminateMs: args.observeAfterTerminateMs,
          handleExe: args.handleExe,
        });
        results.push(workerResult);
        printProgress(workerResult);

        const forkResult = await runForkIteration({
          rootDir,
          iteration,
          shareMode,
          terminateAfterMs: args.terminateAfterMs,
          observeAfterTerminateMs: args.observeAfterTerminateMs,
          handleExe: args.handleExe,
        });
        results.push(forkResult);
        printProgress(forkResult);
      }
    }

    const summary = summarize(results);
    console.log('\n=== Summary ===');
    console.log(JSON.stringify(summary, null, 2));
    console.log('\n=== Raw Results ===');
    console.log(JSON.stringify({ args, rootDir, results }, null, 2));
  } finally {
    if (args.keepArtifacts) {
      console.log(`\nArtifacts kept at: ${rootDir}`);
    } else {
      await rm(rootDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[2] === '--worker-probe-child') {
  workerProbeChildMain(process.argv.slice(3)).catch((error) => {
    emitChildEvent({ event: 'child_error', code: error.code, message: error.message });
    process.exitCode = 2;
  });
} else if (process.argv[2] === '--fork-probe-child') {
  forkProbeChildMain(process.argv.slice(3)).catch((error) => {
    emitChildEvent({ event: 'child_error', code: error.code, message: error.message });
    process.exitCode = 2;
  });
} else {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
