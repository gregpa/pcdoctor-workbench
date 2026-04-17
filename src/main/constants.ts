import path from 'node:path';
import os from 'node:os';

/** Root of existing PCDoctor PowerShell stack. */
export const PCDOCTOR_ROOT = 'C:\\ProgramData\\PCDoctor';

/** Path to the live diagnostic JSON written by Invoke-PCDoctor.ps1. */
export const LATEST_JSON_PATH = path.join(PCDOCTOR_ROOT, 'reports', 'latest.json');

/** Path where Workbench stores its own SQLite database. */
export const WORKBENCH_DB_PATH = path.join(PCDOCTOR_ROOT, 'workbench.db');

/** Path where electron-log should write main-process logs. */
export const LOG_DIR = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'PCDoctor', 'logs');

/** Default PowerShell executable — prefer 7+ if installed, fallback to 5.1. */
export function resolvePwshPath(): string {
  const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  return pwsh7;   // Caller may fall back to pwsh51 if pwsh7 missing — see scriptRunner
}
export const PWSH_FALLBACK = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** Default script execution timeout (5 min). */
export const DEFAULT_SCRIPT_TIMEOUT_MS = 5 * 60 * 1000;

/** Names of Windows scheduled tasks managed by Workbench. */
export const AUTOSTART_TASK_NAME = 'PCDoctor-Workbench-Autostart';

/** Status-polling interval in renderer. */
export const POLL_INTERVAL_MS = 60 * 1000;
