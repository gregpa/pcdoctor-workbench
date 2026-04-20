import { spawn, spawnSync, type SpawnOptions } from 'node:child_process';
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
 * non-elevated parent, so we redirect its streams to temp files and read
 * them back after the child exits. Triggers a single UAC prompt per call.
 *
 * Reviewers P1:
 *   - Use randomBytes(16) + O_EXCL to create the tmp files (not Math.random()
 *     Date.now() + predictable suffix, which was TOCTOU-racy on symlinks).
 *   - Keep stdout, stderr, and exit code on separate files so warnings /
 *     Write-Host noise in one stream doesn't poison the JSON parser.
 */
/**
 * Check whether UAC is enabled on this machine. When EnableLUA=0, every
 * "Start-Process -Verb RunAs" attempt silently runs unelevated - the action
 * script's IsInRole(Administrator) check then returns False and we emit
 * E_NOT_ADMIN 300-500ms later with no dialog ever shown. Callers can use
 * this to short-circuit with a clear error rather than a confusing exit 1.
 */
let _uacCache: { value: boolean; at: number } | null = null;
export function isUacEnabled(): boolean {
  // Cache for 60s - the check is cheap but runs on every admin action.
  if (_uacCache && Date.now() - _uacCache.at < 60_000) return _uacCache.value;
  try {
    const r = spawnSync('reg.exe', [
      'query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System',
      '/v', 'EnableLUA',
    ], { encoding: 'utf8', timeout: 3_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    // Output contains e.g. "EnableLUA    REG_DWORD    0x1"
    const m = (r.stdout ?? '').match(/EnableLUA\s+REG_DWORD\s+0x([0-9a-fA-F]+)/);
    const enabled = m ? parseInt(m[1], 16) !== 0 : true;
    _uacCache = { value: enabled, at: Date.now() };
    return enabled;
  } catch {
    return true; // conservative default
  }
}

export async function runElevatedPowerShellScript<T = unknown>(
  relativeScriptPath: string,
  args: string[] = [],
  opts: RunOptions = {},
): Promise<T> {
  const scriptPath = path.join(PCDOCTOR_ROOT, relativeScriptPath.replace(/\//g, '\\'));
  const pwsh = existsSync(resolvePwshPath()) ? resolvePwshPath() : PWSH_FALLBACK;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;

  // CSPRNG + per-call unique base. 16 bytes = 128 bits of entropy.
  const { randomBytes } = await import('node:crypto');
  const uniq = `pcdoctor-elevated-${randomBytes(16).toString('hex')}`;
  const outPath = path.join(os.tmpdir(), `${uniq}.out`);
  const errPath = path.join(os.tmpdir(), `${uniq}.err`);
  const exitPath = path.join(os.tmpdir(), `${uniq}.exit`);

  // Pre-create each temp file with O_EXCL so an attacker can't pre-create a
  // symlink at this path that would redirect the elevated child's writes.
  const { openSync, closeSync, constants: fsC } = await import('node:fs');
  for (const p of [outPath, errPath, exitPath]) {
    try {
      closeSync(openSync(p, fsC.O_CREAT | fsC.O_EXCL | fsC.O_WRONLY, 0o600));
    } catch (e: any) {
      throw new PCDoctorScriptError('E_ELEVATED_TEMP_EXISTS', `Elevated tmp file collision: ${p} (${e?.code ?? 'unknown'})`);
    }
  }

  const safeScript = scriptPath.replace(/'/g, "''");
  const safeOut = outPath.replace(/'/g, "''");
  const safeErr = errPath.replace(/'/g, "''");
  const safeExit = exitPath.replace(/'/g, "''");
  const argsStr = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');

  // Streams are kept separate:
  //   1>  stdout        -> outPath     (expected to contain JSON)
  //   2>  error stream  -> errPath     (PS errors, Write-Error)
  //   $LASTEXITCODE     -> exitPath    (the actual exit code)
  // Write-Warning / Write-Verbose / Write-Information stream to their
  // respective channels and are dropped so they can't poison JSON.
  const innerCmd =
    `try { ` +
    `  & '${safeScript}' ${argsStr ? `@(${argsStr})` : ''} 1>'${safeOut}' 2>'${safeErr}'; ` +
    `  $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }; ` +
    `  Set-Content -Path '${safeExit}' -Value $code -Encoding ascii ` +
    `} catch { ` +
    `  $_ | Out-String | Add-Content -Path '${safeErr}'; ` +
    `  Set-Content -Path '${safeExit}' -Value 1 -Encoding ascii ` +
    `}`;

  // v2.4.1: -WindowStyle Hidden + -WindowStyle Hidden on both the outer
  // Start-Process AND the child pwsh args so the elevated console never
  // flashes visible. Previously users saw an empty black PS window for the
  // full duration of long actions (SFC, DISM, Defender scans) because
  // output was redirected to temp files and nothing rendered on screen.
  // Workbench tile spinner already shows progress; the hidden window keeps
  // focus on the app.
  const outerCmd =
    `$p = Start-Process -FilePath '${pwsh.replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
    `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NonInteractive','-WindowStyle','Hidden','-Command','${innerCmd.replace(/'/g, "''")}'); ` +
    `exit $p.ExitCode`;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(pwsh, ['-NoProfile', '-NonInteractive', '-Command', outerCmd], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let wrapStderr = '';
    child.stderr?.on('data', (c: Buffer) => { wrapStderr += c.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new PCDoctorScriptError('E_TIMEOUT_KILLED', `Elevated script exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 1223) { reject(new PCDoctorScriptError('E_UAC_CANCELLED', 'UAC prompt was cancelled by user')); return; }
      // Wrapper failed *and* no output captured - treat as a hard elevation error.
      if (code !== 0 && !existsSync(outPath)) {
        reject(new PCDoctorScriptError('E_ELEVATION_FAILED', `Elevation wrapper exit ${code}: ${wrapStderr.slice(0, 200)}`));
        return;
      }
      resolve();
    });
  });

  // Read captured streams + exit code.
  let stdout = ''; try { stdout = readFileSync(outPath, 'utf8'); } catch {}
  let stderr = ''; try { stderr = readFileSync(errPath, 'utf8'); } catch {}
  let exitStr = ''; try { exitStr = readFileSync(exitPath, 'utf8').trim(); } catch {}
  for (const p of [outPath, errPath, exitPath]) { try { unlinkSync(p); } catch {} }

  const childExit = parseInt(exitStr, 10);

  // Sentinel can appear on stdout (trap wrote there) OR stderr (PS error). Check both.
  const combined = stdout + '\n' + stderr;
  const sentinelMatch = combined.match(/PCDOCTOR_ERROR:(.+)$/m);
  if (sentinelMatch) {
    try {
      const parsed = JSON.parse(sentinelMatch[1]);
      throw new PCDoctorScriptError(parsed.code ?? 'E_PS_UNHANDLED', parsed.message ?? 'Elevated script reported an error', parsed);
    } catch (e) {
      if (e instanceof PCDoctorScriptError) throw e;
      throw new PCDoctorScriptError('E_PS_UNHANDLED', 'Elevated script reported an error (unparseable)', { stdout, stderr });
    }
  }

  // Non-zero child exit without a sentinel - surface it clearly.
  if (!isNaN(childExit) && childExit !== 0) {
    throw new PCDoctorScriptError('E_PS_NONZERO_EXIT', `Elevated script exited with code ${childExit}`, { exitCode: childExit, stdout: stdout.slice(0, 1000), stderr: stderr.slice(0, 1000) });
  }

  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new PCDoctorScriptError('E_PS_INVALID_JSON', 'Elevated script did not return valid JSON on stdout', { stdout: trimmed.slice(0, 1000), stderr: stderr.slice(0, 1000) });
  }
}
