import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

/**
 * Run a PowerShell script under C:\ProgramData\PCDoctor\ **elevated** via
 * Start-Process -Verb RunAs. The elevated child can't inherit pipes from our
 * non-elevated parent, so we redirect its stdout to a temp file and read it
 * back after the child exits. Triggers a single UAC prompt per invocation.
 */
export async function runElevatedPowerShellScript<T = unknown>(
  relativeScriptPath: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<T> {
  const scriptPath = path.join(PCDOCTOR_ROOT, relativeScriptPath.replace(/\//g, '\\'));
  const pwsh = existsSync(resolvePwshPath()) ? resolvePwshPath() : PWSH_FALLBACK;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  const uniq = `pcdoctor-elevated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const outPath = path.join(os.tmpdir(), `${uniq}.out`);
  const exitPath = path.join(os.tmpdir(), `${uniq}.exit`);

  // Build the inner command the elevated PS will execute. Redirect *both*
  // streams to outPath (*> merges stdout+stderr), then write the exit code
  // to exitPath. Use try/finally so we always write the exit marker even on
  // exception.
  const safeScript = scriptPath.replace(/'/g, "''");
  const safeOut = outPath.replace(/'/g, "''");
  const safeExit = exitPath.replace(/'/g, "''");
  const argsStr = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  const innerCmd =
    `try { & '${safeScript}' ${argsStr ? `@(${argsStr})` : ''} *>'${safeOut}'; ` +
    `$LASTEXITCODE | Out-File -Encoding ASCII '${safeExit}' } ` +
    `catch { $_ | Out-String | Out-File -Append '${safeOut}'; 1 | Out-File -Encoding ASCII '${safeExit}' }`;

  // Outer command: use Start-Process -Verb RunAs -Wait which triggers UAC.
  // The outer process itself is non-elevated and just waits for the child.
  const outerCmd =
    `$p = Start-Process -FilePath '${pwsh.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NonInteractive','-Command','${innerCmd.replace(/'/g, "''")}'); ` +
    `exit $p.ExitCode`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', outerCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new PCDoctorScriptError('E_TIMEOUT_KILLED', `Elevated script exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      // Exit code 1223 = UAC cancelled by user.
      if (code === 1223) { reject(new PCDoctorScriptError('E_UAC_CANCELLED', 'UAC prompt was cancelled by user')); return; }
      if (code !== 0 && !existsSync(outPath)) {
        reject(new PCDoctorScriptError('E_ELEVATION_FAILED', `Elevation wrapper exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve();
    });
  });

  // Read captured output.
  let stdout = '';
  try { stdout = readFileSync(outPath, 'utf8'); } catch {}
  try { unlinkSync(outPath); } catch {}
  try { unlinkSync(exitPath); } catch {}

  // Check for PCDOCTOR_ERROR sentinel
  const sentinelMatch = stdout.match(/PCDOCTOR_ERROR:(.+)$/m);
  if (sentinelMatch) {
    try {
      const parsed = JSON.parse(sentinelMatch[1]);
      throw new PCDoctorScriptError(parsed.code ?? 'E_PS_UNHANDLED', parsed.message ?? 'Elevated script reported an error', parsed);
    } catch (e) {
      if (e instanceof PCDoctorScriptError) throw e;
      throw new PCDoctorScriptError('E_PS_UNHANDLED', 'Elevated script reported an error (unparseable)', { stdout });
    }
  }

  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new PCDoctorScriptError('E_PS_INVALID_JSON', 'Elevated script did not return valid JSON', { stdout: trimmed.slice(0, 1000) });
  }
}
