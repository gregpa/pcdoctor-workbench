// v2.4.48 (B48-SEC-1): allowlist regex for renderer-controlled scheduled-
// task names. Extracted from ipc.ts so the tests can import the constant
// without pulling the entire IPC handler module (which transitively pulls
// electron-updater, better-sqlite3, etc., none of which are loadable from
// a vitest node environment).

/**
 * Two-layer defence at the IPC entrypoint:
 *   1. SCHEDULED_TASK_NAME_RE rejects shell-metachar smuggling BEFORE
 *      MANAGED_TASKS.has(...) -- catches injection attempts even if a
 *      future MANAGED_TASKS edit relaxes the canonical name list.
 *   2. The runSchtasks helper calls execFile('schtasks.exe', args) with
 *      array-form args (no shell parser) so an arg cannot reach a shell
 *      even if the regex regresses.
 *
 * Pattern:
 *   - "PCDoctor-" literal prefix (every task PCDoctor manages).
 *   - 1-64 chars from [A-Za-z0-9_-]. 64 is comfortably above the longest
 *     current name ('PCDoctor-Autopilot-UpdateHostsStevenBlack' = 41) and
 *     below the practical Windows-task-name limit.
 */
export const SCHEDULED_TASK_NAME_RE = /^PCDoctor-[A-Za-z0-9_-]{1,64}$/;
