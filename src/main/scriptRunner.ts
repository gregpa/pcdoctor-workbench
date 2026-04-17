import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import {
  PCDOCTOR_ROOT,
  resolvePwshPath,
  PWSH_FALLBACK,
  DEFAULT_SCRIPT_TIMEOUT_MS,
} from './constants.js';

export class PCDoctorScriptError extends Error {
  code: string;
  details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export interface RunOptions {
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/**
 * Spawn a PowerShell script under C:\ProgramData\PCDoctor\.
 * Returns the parsed JSON written on stdout.
 * Throws PCDoctorScriptError on failure with a stable error code.
 */
export async function runPowerShellScript<T = unknown>(
  relativeScriptPath: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<T> {
  const scriptPath = path.join(PCDOCTOR_ROOT, relativeScriptPath.replace(/\//g, '\\'));
  const pwsh = existsSync(resolvePwshPath()) ? resolvePwshPath() : PWSH_FALLBACK;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  const spawnArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-NonInteractive',
    '-File', scriptPath,
    ...args,
  ];

  const spawnOpts: SpawnOptions = { stdio: ['ignore', 'pipe', 'pipe'] };
  const child = spawn(pwsh, spawnArgs, spawnOpts);

  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch {}
    // Escalate to SIGKILL after 5s
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
  }, timeoutMs);

  child.stdout?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stdout += s;
    opts.onStdout?.(s);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const s = chunk.toString('utf8');
    stderr += s;
    opts.onStderr?.(s);
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on('exit', (code) => resolve(code ?? -1));
  });

  clearTimeout(timer);

  if (timedOut) {
    throw new PCDoctorScriptError('E_TIMEOUT_KILLED', `Script exceeded ${timeoutMs}ms and was killed`, {
      script: relativeScriptPath,
      stdout,
      stderr,
    });
  }

  // Check for PCDOCTOR_ERROR sentinel anywhere in stdout
  const sentinelMatch = stdout.match(/PCDOCTOR_ERROR:(.+)$/m);
  if (sentinelMatch) {
    try {
      const parsed = JSON.parse(sentinelMatch[1]);
      throw new PCDoctorScriptError(
        parsed.code ?? 'E_PS_UNHANDLED',
        parsed.message ?? 'PowerShell script reported an error',
        parsed,
      );
    } catch (e) {
      if (e instanceof PCDoctorScriptError) throw e;
      throw new PCDoctorScriptError('E_PS_UNHANDLED', 'PowerShell script reported an error (unparseable)', { stdout, stderr });
    }
  }

  if (exitCode !== 0) {
    throw new PCDoctorScriptError('E_PS_NONZERO_EXIT', `Script exited with code ${exitCode}`, { exitCode, stdout, stderr });
  }

  // Strip any lines that look like informational logs; last non-empty line should be JSON
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new PCDoctorScriptError('E_PS_INVALID_JSON', 'Script did not return valid JSON on stdout', {
      stdout: trimmed.slice(0, 1000),
      stderr: stderr.slice(0, 1000),
    });
  }
}
