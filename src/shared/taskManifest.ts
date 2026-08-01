/**
 * Canonical, fail-closed Scheduled Task contract shared by main and renderer code.
 * The generated PowerShell copy is derived from task-manifest.json; consumers never
 * maintain their own task-name lists.
 */

import rawTaskManifest from './task-manifest.json';

export type TaskState = 'active' | 'deferred' | 'remove';
export type TaskContext = 'interactive-user' | 'system';
export type TaskEffect = 'read-only' | 'pcdoctor-data' | 'system-mutation';
export type TaskWorkload = 'light' | 'medium' | 'heavy';
export type TaskMigrationStrategy = 'register' | 'unregister';

export type TaskSchedule =
  | Readonly<{ kind: 'logon' | 'demand' }>
  | Readonly<{ kind: 'daily'; at: string }>
  | Readonly<{ kind: 'weekly'; day: string; at: string }>
  | Readonly<{ kind: 'monthly-day'; day: number; at: string }>
  | Readonly<{ kind: 'monthly-weekday'; week: string; day: string; at: string }>;

export interface TaskManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly state: TaskState;
  readonly executable: 'powershell.exe' | 'PCDoctor Workbench.exe';
  readonly script: string | null;
  readonly arguments: readonly string[];
  readonly context: TaskContext;
  readonly hidden: boolean;
  readonly effect: TaskEffect;
  readonly workload: TaskWorkload;
  readonly schedule: TaskSchedule;
  readonly migration: Readonly<{
    strategy: TaskMigrationStrategy;
    legacy_names: readonly string[];
  }>;
  readonly uninstall: Readonly<{ remove: true }>;
}

export interface TaskManifest {
  readonly schema_version: 1;
  readonly tasks: readonly TaskManifestEntry[];
}

const ROOT_KEYS = ['schema_version', 'tasks'] as const;
const TASK_KEYS = [
  'id', 'name', 'state', 'executable', 'script', 'arguments', 'context', 'hidden',
  'effect', 'workload', 'schedule', 'migration', 'uninstall',
] as const;
const MIGRATION_KEYS = ['strategy', 'legacy_names'] as const;
const UNINSTALL_KEYS = ['remove'] as const;
const TASK_NAME_RE = /^PCDoctor-[A-Za-z0-9_-]{1,64}$/;
const TASK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const DAYS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']);
const WEEKS = new Set(['first', 'second', 'third', 'fourth', 'last']);
const STATES = new Set<TaskState>(['active', 'deferred', 'remove']);
const CONTEXTS = new Set<TaskContext>(['interactive-user', 'system']);
const EFFECTS = new Set<TaskEffect>(['read-only', 'pcdoctor-data', 'system-mutation']);
const WORKLOADS = new Set<TaskWorkload>(['light', 'medium', 'heavy']);
const EXECUTABLES = new Set(['powershell.exe', 'PCDoctor Workbench.exe']);
const ARGUMENT_TOKENS = new Set(['--hidden', '-Mode', 'Report', 'Auto', 'DeepScan']);
const FIXED_SCRIPTS = new Set([
  'C:\\ProgramData\\PCDoctor\\Invoke-PCDoctor.ps1',
  'C:\\ProgramData\\PCDoctor\\Get-Forecast.ps1',
  'C:\\ProgramData\\PCDoctor\\Invoke-WeeklyReview.ps1',
  'C:\\ProgramData\\PCDoctor\\Prune-Rollbacks.ps1',
  'C:\\ProgramData\\PCDoctor\\Refresh-NasRecycleSizes.ps1',
  'C:\\ProgramData\\PCDoctor\\Check-ToolUpdates.ps1',
  'C:\\ProgramData\\PCDoctor\\security\\Get-SecurityPosture.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Update-DefenderDefs.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-DefenderQuickScan.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-AdwCleanerScan.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Clear-BrowserCaches.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Update-HostsFromStevenBlack.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-HwinfoLog.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-MalwarebytesCli.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Empty-RecycleBins.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-SafetyScanner.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-SmartCheck.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Shrink-ComponentStore.ps1',
  'C:\\Program Files\\PCDoctor Workbench\\privileged\\Maintenance-Broker.ps1',
]);
const ACTIVE_SAFE_SCRIPTS = new Set([
  'C:\\ProgramData\\PCDoctor\\Invoke-PCDoctor.ps1',
  'C:\\ProgramData\\PCDoctor\\Refresh-NasRecycleSizes.ps1',
  'C:\\ProgramData\\PCDoctor\\Check-ToolUpdates.ps1',
  'C:\\ProgramData\\PCDoctor\\security\\Get-SecurityPosture.ps1',
  'C:\\ProgramData\\PCDoctor\\actions\\Run-SmartCheck.ps1',
]);
const ACTIVE_ARGUMENT_CONTRACTS = new Map<string, readonly string[]>([
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Invoke-PCDoctor.ps1', ['-Mode', 'Report']],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Refresh-NasRecycleSizes.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Check-ToolUpdates.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\security\\Get-SecurityPosture.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\actions\\Run-SmartCheck.ps1', []],
  ['PCDoctor Workbench.exe\0', ['--hidden']],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} has unknown key '${unknown}'`);
  const missing = allowed.find(key => !(key in value));
  if (missing) throw new Error(`${label} is missing key '${missing}'`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
}

function validateTime(value: unknown, label: string): asserts value is string {
  assertString(value, label);
  if (!TIME_RE.test(value)) throw new Error(`${label} must use HH:mm`);
}

function validateSchedule(value: unknown, label: string): TaskSchedule {
  assertRecord(value, label);
  assertString(value.kind, `${label}.kind`);
  switch (value.kind) {
    case 'logon':
    case 'demand':
      rejectUnknownKeys(value, ['kind'], label);
      break;
    case 'daily':
      rejectUnknownKeys(value, ['kind', 'at'], label);
      validateTime(value.at, `${label}.at`);
      break;
    case 'weekly':
      rejectUnknownKeys(value, ['kind', 'day', 'at'], label);
      assertString(value.day, `${label}.day`);
      if (!DAYS.has(value.day)) throw new Error(`${label}.day is invalid`);
      validateTime(value.at, `${label}.at`);
      break;
    case 'monthly-day':
      rejectUnknownKeys(value, ['kind', 'day', 'at'], label);
      if (!Number.isInteger(value.day) || Number(value.day) < 1 || Number(value.day) > 31) {
        throw new Error(`${label}.day is invalid`);
      }
      validateTime(value.at, `${label}.at`);
      break;
    case 'monthly-weekday':
      rejectUnknownKeys(value, ['kind', 'week', 'day', 'at'], label);
      assertString(value.week, `${label}.week`);
      assertString(value.day, `${label}.day`);
      if (!WEEKS.has(value.week)) throw new Error(`${label}.week is invalid`);
      if (!DAYS.has(value.day)) throw new Error(`${label}.day is invalid`);
      validateTime(value.at, `${label}.at`);
      break;
    default:
      throw new Error(`${label}.kind is invalid`);
  }
  return value as TaskSchedule;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function validateEntry(value: unknown, index: number): TaskManifestEntry {
  const label = `tasks[${index}]`;
  assertRecord(value, label);
  rejectUnknownKeys(value, TASK_KEYS, label);

  assertString(value.id, `${label}.id`);
  assertString(value.name, `${label}.name`);
  assertString(value.state, `${label}.state`);
  assertString(value.executable, `${label}.executable`);
  assertString(value.context, `${label}.context`);
  assertString(value.effect, `${label}.effect`);
  assertString(value.workload, `${label}.workload`);
  if (!TASK_ID_RE.test(value.id)) throw new Error(`${label}.id is invalid`);
  if (!TASK_NAME_RE.test(value.name)) throw new Error(`${label}.name is invalid`);
  if (!STATES.has(value.state as TaskState)) throw new Error(`${label}.state is invalid`);
  if (!EXECUTABLES.has(value.executable)) throw new Error(`${label}.executable is not fixed`);
  if (!CONTEXTS.has(value.context as TaskContext)) throw new Error(`${label}.context is invalid`);
  if (!EFFECTS.has(value.effect as TaskEffect)) throw new Error(`${label}.effect is invalid`);
  if (!WORKLOADS.has(value.workload as TaskWorkload)) throw new Error(`${label}.workload is invalid`);
  if (typeof value.hidden !== 'boolean') throw new Error(`${label}.hidden must be boolean`);

  if (!Array.isArray(value.arguments) || value.arguments.some(arg => typeof arg !== 'string')) {
    throw new Error(`${label}.arguments must be a string array`);
  }
  for (const argument of value.arguments as string[]) {
    if (!ARGUMENT_TOKENS.has(argument)) throw new Error(`${label}.argument '${argument}' is not fixed`);
  }

  if (value.executable === 'powershell.exe') {
    assertString(value.script, `${label}.script`);
    if (!FIXED_SCRIPTS.has(value.script)) throw new Error(`${label}.script is not a fixed allowlisted path`);
  } else {
    if (value.script !== null) throw new Error(`${label}.script must be null for the Workbench executable`);
    if (value.id !== 'workbench-autostart' || value.arguments.length !== 1 || value.arguments[0] !== '--hidden') {
      throw new Error(`${label}.arguments are invalid for the Workbench executable`);
    }
  }

  const schedule = validateSchedule(value.schedule, `${label}.schedule`);
  assertRecord(value.migration, `${label}.migration`);
  rejectUnknownKeys(value.migration, MIGRATION_KEYS, `${label}.migration`);
  assertString(value.migration.strategy, `${label}.migration.strategy`);
  if (!Array.isArray(value.migration.legacy_names)
    || value.migration.legacy_names.some(name => typeof name !== 'string' || !TASK_NAME_RE.test(name))) {
    throw new Error(`${label}.migration.legacy_names is invalid`);
  }
  assertRecord(value.uninstall, `${label}.uninstall`);
  rejectUnknownKeys(value.uninstall, UNINSTALL_KEYS, `${label}.uninstall`);
  if (value.uninstall.remove !== true) throw new Error(`${label}.uninstall.remove must be true`);

  const state = value.state as TaskState;
  const strategy = value.migration.strategy;
  if (state === 'active') {
    if (!value.hidden) throw new Error(`${label}: active tasks must be hidden`);
    if (strategy !== 'register') throw new Error(`${label}: active migration strategy must register`);
    if (value.effect === 'system-mutation') throw new Error(`${label}: active system mutation is forbidden`);
    if (value.executable === 'powershell.exe' && !ACTIVE_SAFE_SCRIPTS.has(value.script as string)) {
      throw new Error(`${label}: active script is not in the read-only/application-owned allowlist`);
    }
    if (value.context === 'system'
      && typeof value.script === 'string'
      && value.script.startsWith('C:\\ProgramData\\PCDoctor\\')) {
      throw new Error(`${label}: active SYSTEM tasks cannot execute ProgramData scripts`);
    }
    if (value.context !== 'interactive-user') {
      throw new Error(`${label}: active tasks must use the interactive user`);
    }
    const commandKey = `${value.executable}\0${value.script ?? ''}`;
    const expectedArguments = ACTIVE_ARGUMENT_CONTRACTS.get(commandKey);
    if (!expectedArguments
      || value.arguments.length !== expectedArguments.length
      || value.arguments.some((argument, index) => argument !== expectedArguments[index])) {
      throw new Error(`${label}: active arguments violate the exact command contract`);
    }
    const commandText = [value.executable, value.script, ...value.arguments].join(' ');
    if (/Run-AutopilotScheduled|reboot|shutdown|ResetBase/i.test(commandText)) {
      throw new Error(`${label}: active dispatcher/reboot/mutation command is forbidden`);
    }
    if (schedule.kind === 'demand') throw new Error(`${label}: an active calendar task needs a fixed trigger`);
  } else if (strategy !== 'unregister') {
    throw new Error(`${label}: inactive migration strategy must unregister`);
  }

  return value as unknown as TaskManifestEntry;
}

export function validateTaskManifest(value: unknown): TaskManifest {
  assertRecord(value, 'manifest');
  rejectUnknownKeys(value, ROOT_KEYS, 'manifest');
  if (value.schema_version !== 1) throw new Error('manifest.schema_version must be 1');
  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    throw new Error('manifest.tasks must be a non-empty array');
  }
  const entries = value.tasks.map(validateEntry);
  const ids = new Set<string>();
  const names = new Set<string>();
  const legacyNames = new Set<string>();
  const activeTimes = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new Error(`duplicate task id '${entry.id}'`);
    ids.add(entry.id);
    const foldedName = entry.name.toLowerCase();
    if (names.has(foldedName)) throw new Error(`duplicate task name '${entry.name}'`);
    names.add(foldedName);
    if (entry.state === 'active' && 'at' in entry.schedule) {
      if (entry.schedule.at.endsWith(':00')) throw new Error(`active task '${entry.id}' is not staggered`);
      if (activeTimes.has(entry.schedule.at)) throw new Error(`duplicate active schedule time '${entry.schedule.at}'`);
      activeTimes.add(entry.schedule.at);
    }
  }
  for (const entry of entries) {
    for (const legacyName of entry.migration.legacy_names) {
      const foldedLegacyName = legacyName.toLowerCase();
      if (names.has(foldedLegacyName)) {
        throw new Error(`legacy name '${legacyName}' collides with a canonical task name`);
      }
      if (legacyNames.has(foldedLegacyName)) {
        throw new Error(`duplicate legacy task name '${legacyName}'`);
      }
      legacyNames.add(foldedLegacyName);
    }
  }
  const sortedIds = [...ids].sort((a, b) => a.localeCompare(b));
  if (entries.some((entry, index) => entry.id !== sortedIds[index])) {
    throw new Error('manifest.tasks must be sorted by stable id');
  }
  return deepFreeze(value as unknown as TaskManifest) as TaskManifest;
}

export const taskManifest = validateTaskManifest(rawTaskManifest);
export const ACTIVE_TASKS = Object.freeze(taskManifest.tasks.filter(task => task.state === 'active'));

export function getTaskById(id: string): TaskManifestEntry {
  const task = taskManifest.tasks.find(candidate => candidate.id === id);
  if (!task) throw new Error(`Unknown task id '${id}'`);
  return task;
}

export const DAILY_QUICK_TASK_NAME = getTaskById('daily-quick-report').name;
