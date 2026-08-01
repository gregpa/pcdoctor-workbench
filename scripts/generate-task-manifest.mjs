import { createHash } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const sourcePath = path.join(repoRoot, 'src', 'shared', 'task-manifest.json');
const defaultOutputPath = path.join(repoRoot, 'powershell', 'task-manifest.json');

function stableObject(value) {
  if (Array.isArray(value)) return value.map(stableObject);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableObject(value[key])]));
  }
  return value;
}

const ROOT_KEYS = ['schema_version', 'tasks'];
const TASK_KEYS = [
  'id', 'name', 'state', 'executable', 'script', 'arguments', 'context', 'hidden',
  'effect', 'workload', 'schedule', 'migration', 'uninstall',
];
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
const ACTIVE_ARGUMENT_CONTRACTS = new Map([
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Invoke-PCDoctor.ps1', ['-Mode', 'Report']],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Refresh-NasRecycleSizes.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\Check-ToolUpdates.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\security\\Get-SecurityPosture.ps1', []],
  ['powershell.exe\0C:\\ProgramData\\PCDoctor\\actions\\Run-SmartCheck.ps1', []],
  ['PCDoctor Workbench.exe\0', ['--hidden']],
]);
const TASK_NAME_RE = /^PCDoctor-[A-Za-z0-9_-]{1,64}$/;
const TASK_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function assertRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function requireExactKeys(value, allowed, label) {
  assertRecord(value, label);
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find(key => !allowedSet.has(key));
  if (unknown) throw new Error(`${label} has unknown key '${unknown}'`);
  const missing = allowed.find(key => !(key in value));
  if (missing) throw new Error(`${label} is missing key '${missing}'`);
}

function assertString(value, label) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
}

function validateSchedule(schedule, label) {
  assertRecord(schedule, label);
  assertString(schedule.kind, `${label}.kind`);
  const fixed = {
    logon: ['kind'],
    demand: ['kind'],
    daily: ['kind', 'at'],
    weekly: ['kind', 'day', 'at'],
    'monthly-day': ['kind', 'day', 'at'],
    'monthly-weekday': ['kind', 'week', 'day', 'at'],
  }[schedule.kind];
  if (!fixed) throw new Error(`${label}.kind is invalid`);
  requireExactKeys(schedule, fixed, label);
  if ('at' in schedule && (typeof schedule.at !== 'string' || !TIME_RE.test(schedule.at))) {
    throw new Error(`${label}.at must use HH:mm`);
  }
  if (schedule.kind === 'weekly' || schedule.kind === 'monthly-weekday') {
    if (!new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']).has(schedule.day)) {
      throw new Error(`${label}.day is invalid`);
    }
  }
  if (schedule.kind === 'monthly-day'
    && (!Number.isInteger(schedule.day) || schedule.day < 1 || schedule.day > 31)) {
    throw new Error(`${label}.day is invalid`);
  }
  if (schedule.kind === 'monthly-weekday'
    && !new Set(['first', 'second', 'third', 'fourth', 'last']).has(schedule.week)) {
    throw new Error(`${label}.week is invalid`);
  }
}

function validateEntry(task, index) {
  const label = `tasks[${index}]`;
  requireExactKeys(task, TASK_KEYS, label);
  for (const key of ['id', 'name', 'state', 'executable', 'context', 'effect', 'workload']) {
    assertString(task[key], `${label}.${key}`);
  }
  if (!TASK_ID_RE.test(task.id)) throw new Error(`${label}.id is invalid`);
  if (!TASK_NAME_RE.test(task.name)) throw new Error(`${label}.name is invalid`);
  if (!new Set(['active', 'deferred', 'remove']).has(task.state)) throw new Error(`${label}.state is invalid`);
  if (!new Set(['powershell.exe', 'PCDoctor Workbench.exe']).has(task.executable)) {
    throw new Error(`${label}.executable is not fixed`);
  }
  if (!new Set(['interactive-user', 'system']).has(task.context)) throw new Error(`${label}.context is invalid`);
  if (!new Set(['read-only', 'pcdoctor-data', 'system-mutation']).has(task.effect)) {
    throw new Error(`${label}.effect is invalid`);
  }
  if (!new Set(['light', 'medium', 'heavy']).has(task.workload)) throw new Error(`${label}.workload is invalid`);
  if (typeof task.hidden !== 'boolean') throw new Error(`${label}.hidden must be boolean`);
  if (!Array.isArray(task.arguments) || task.arguments.some(argument => typeof argument !== 'string')) {
    throw new Error(`${label}.arguments must be a string array`);
  }
  const fixedArguments = new Set(['--hidden', '-Mode', 'Report', 'Auto', 'DeepScan']);
  for (const argument of task.arguments) {
    if (!fixedArguments.has(argument)) throw new Error(`${label}.argument '${argument}' is not fixed`);
  }
  if (task.executable === 'powershell.exe') {
    if (typeof task.script !== 'string' || !FIXED_SCRIPTS.has(task.script)) {
      throw new Error(`${label}.script is not a fixed allowlisted path`);
    }
  } else if (task.script !== null
    || task.id !== 'workbench-autostart'
    || task.arguments.length !== 1
    || task.arguments[0] !== '--hidden') {
    throw new Error(`${label}.Workbench command is invalid`);
  }

  validateSchedule(task.schedule, `${label}.schedule`);
  requireExactKeys(task.migration, ['strategy', 'legacy_names'], `${label}.migration`);
  if (!new Set(['register', 'unregister']).has(task.migration.strategy)) {
    throw new Error(`${label}.migration.strategy is invalid`);
  }
  if (!Array.isArray(task.migration.legacy_names)
    || task.migration.legacy_names.some(name => typeof name !== 'string' || !TASK_NAME_RE.test(name))) {
    throw new Error(`${label}.migration.legacy_names is invalid`);
  }
  requireExactKeys(task.uninstall, ['remove'], `${label}.uninstall`);
  if (task.uninstall.remove !== true) throw new Error(`${label}.uninstall.remove must be true`);

  if (task.state === 'active') {
    if (!task.hidden) throw new Error(`${label}: active tasks must be hidden`);
    if (task.migration.strategy !== 'register') throw new Error(`${label}: active migration must register`);
    if (task.effect === 'system-mutation') throw new Error(`${label}: active system mutation is forbidden`);
    if (task.executable === 'powershell.exe' && !ACTIVE_SAFE_SCRIPTS.has(task.script)) {
      throw new Error(`${label}: active script is not in the safe allowlist`);
    }
    if (task.context === 'system'
      && typeof task.script === 'string'
      && task.script.startsWith('C:\\ProgramData\\PCDoctor\\')) {
      throw new Error(`${label}: active SYSTEM tasks cannot execute ProgramData scripts`);
    }
    if (task.context !== 'interactive-user') {
      throw new Error(`${label}: active tasks must use the interactive user`);
    }
    const commandKey = `${task.executable}\0${task.script ?? ''}`;
    const expectedArguments = ACTIVE_ARGUMENT_CONTRACTS.get(commandKey);
    if (!expectedArguments
      || task.arguments.length !== expectedArguments.length
      || task.arguments.some((argument, argumentIndex) => argument !== expectedArguments[argumentIndex])) {
      throw new Error(`${label}: active arguments violate the exact command contract`);
    }
    const commandText = [task.executable, task.script, ...task.arguments].join(' ');
    if (/Run-AutopilotScheduled|reboot|shutdown|ResetBase/i.test(commandText)) {
      throw new Error(`${label}: active dispatcher/reboot/mutation command is forbidden`);
    }
    if (task.schedule.kind === 'demand') throw new Error(`${label}: active task requires a fixed trigger`);
  } else if (task.migration.strategy !== 'unregister') {
    throw new Error(`${label}: inactive migration must unregister`);
  }
}

function validateManifest(manifest) {
  requireExactKeys(manifest, ROOT_KEYS, 'manifest');
  if (manifest.schema_version !== 1) throw new Error('manifest.schema_version must be 1');
  if (!Array.isArray(manifest.tasks) || manifest.tasks.length === 0) {
    throw new Error('manifest.tasks must be a non-empty array');
  }
  manifest.tasks.forEach(validateEntry);
  const ids = new Set();
  const names = new Set();
  const legacyNames = new Set();
  const activeTimes = new Set();
  for (const task of manifest.tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id '${task.id}'`);
    ids.add(task.id);
    const foldedName = task.name.toLowerCase();
    if (names.has(foldedName)) throw new Error(`Duplicate task name '${task.name}'`);
    names.add(foldedName);
    if (task.state === 'active' && 'at' in task.schedule) {
      if (task.schedule.at.endsWith(':00')) throw new Error(`Active task '${task.id}' is not staggered`);
      if (activeTimes.has(task.schedule.at)) throw new Error(`Duplicate active schedule '${task.schedule.at}'`);
      activeTimes.add(task.schedule.at);
    }
  }
  for (const task of manifest.tasks) {
    for (const legacyName of task.migration.legacy_names) {
      const foldedLegacyName = legacyName.toLowerCase();
      if (names.has(foldedLegacyName)) {
        throw new Error(`Legacy name '${legacyName}' collides with a canonical task name`);
      }
      if (legacyNames.has(foldedLegacyName)) {
        throw new Error(`Duplicate legacy task name '${legacyName}'`);
      }
      legacyNames.add(foldedLegacyName);
    }
  }
}

function buildOutput() {
  const sourceBytes = readFileSync(sourcePath);
  const manifest = JSON.parse(sourceBytes.toString('utf8'));
  validateManifest(manifest);
  const ids = new Set();
  const names = new Set();
  const tasks = [...manifest.tasks].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id '${task.id}'`);
    const foldedName = String(task.name).toLowerCase();
    if (names.has(foldedName)) throw new Error(`Duplicate task name '${task.name}'`);
    ids.add(task.id);
    names.add(foldedName);
  }
  const generated = stableObject({
    schema_version: manifest.schema_version,
    source_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    tasks,
  });
  return `${JSON.stringify(generated, null, 2)}\n`;
}

function parseArgs(argv) {
  let check = false;
  let outputPath = defaultOutputPath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') check = true;
    else if (arg === '--output' && argv[index + 1]) outputPath = path.resolve(argv[++index]);
    else throw new Error(`Unknown or incomplete argument '${arg}'`);
  }
  return { check, outputPath };
}

const { check, outputPath } = parseArgs(process.argv.slice(2));
const expected = buildOutput();

if (check) {
  let current = null;
  try { current = readFileSync(outputPath, 'utf8'); } catch { /* reported below */ }
  if (current !== expected) {
    process.stderr.write(`Generated task manifest is stale: ${outputPath}\n`);
    process.exitCode = 1;
  }
} else {
  let current = null;
  try { current = readFileSync(outputPath, 'utf8'); } catch { /* generated below */ }
  if (current !== expected) {
    const tempPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(tempPath, expected, { encoding: 'utf8', flag: 'wx' });
      renameSync(tempPath, outputPath);
    } finally {
      rmSync(tempPath, { force: true });
    }
  }
}
