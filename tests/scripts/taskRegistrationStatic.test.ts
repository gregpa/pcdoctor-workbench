// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskManifest } from '../../src/shared/taskManifest.js';

const read = (relativePath: string): string => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

describe('source-only manifest registration contract', () => {
  const register = read('powershell/Register-All-Tasks.ps1');

  it('uses the generated manifest and fixed hidden PowerShell command form', () => {
    expect(register).toContain("Join-Path $PSScriptRoot 'task-manifest.json'");
    expect(register).toContain('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File');
    expect(register).toContain('<Hidden>true</Hidden>');
    expect(register).not.toContain('Run-AutopilotScheduled.ps1');
  });

  it('pins the Workbench executable to the per-machine Program Files install', () => {
    expect(register).toContain("$fixedInstallDir = 'C:\\Program Files\\PCDoctor Workbench'");
    expect(register).toContain('E_INSTALL_DIR_UNTRUSTED');
    expect(register).not.toContain("Join-Path $env:LOCALAPPDATA 'Programs\\PCDoctor Workbench'");
  });

  it('has no copied canonical task identity', () => {
    for (const task of taskManifest.tasks) expect(register).not.toContain(`'${task.name}'`);
  });

  it('unregisters every deferred/removal entry and registers active entries by state', () => {
    expect(register).toContain("if ($task.state -eq 'active')");
    expect(register).toContain('Remove-PCDoctorManifestTask -Name ([string]$task.name)');
    expect(register).toContain('Register-PCDoctorManifestTask -Task $task');
  });

  it('accepts an existing active name only after exact action/context/hidden/trigger drift checks', () => {
    expect(register).toContain('Test-PCDoctorTaskMatchesManifest');
    expect(register).toContain("Invoke-PCDoctorSchtasks -Arguments @('/Query', '/TN', $Name, '/XML', 'ONE')");
    expect(register).toContain("$actualCommand -cne [string]$Command.executable");
    expect(register).toContain("$actualArguments -cne [string]$Command.arguments");
    expect(register).toContain("$actualHidden -cne 'true'");
    expect(register).toContain('Test-PCDoctorTriggerMatchesManifest');
  });

  it('rejects extra actions, ComHandler actions, and extra principals as drift', () => {
    expect(register).toContain('$actionNodes.Count -ne 1');
    expect(register).toContain("$actionNodes[0].LocalName -cne 'Exec'");
    expect(register).toContain('$principalNodes.Count -ne 1');
    expect(register).toContain("$principalNodes[0].LocalName -cne 'Principal'");
  });

  it('constructs no inline PowerShell command and never accepts a task/script argument', () => {
    expect(register).not.toMatch(/arguments\s*=\s*['"][^'"]*-Command\b/i);
    const topLevelParameters = register.slice(0, register.indexOf('$ErrorActionPreference'));
    expect(topLevelParameters).not.toMatch(/\$(?:TaskName|Script|Command)\b/i);
  });

  it('routes every native scheduler call through the PS5.1-safe helper', () => {
    const unregister = read('powershell/Unregister-All-Tasks.ps1');
    for (const source of [register, unregister]) {
      expect(source).toContain(". (Join-Path $PSScriptRoot 'TaskSchedulerNative.ps1')");
      expect(source).toContain('Invoke-PCDoctorSchtasks');
      expect(source).not.toMatch(/&\s+schtasks\.exe/i);
    }
    const helper = read('powershell/TaskSchedulerNative.ps1');
    expect(helper).toContain('[Environment+SpecialFolder]::System');
    expect(helper).toContain('& $script:PCDoctorSchtasksPath @Arguments');
    expect(helper).toContain('Test-PCDoctorTaskQueryAbsent');
    expect(helper).toContain('0x80070002');
  });

  it('registers XML in memory without a user-writable staging pathname', () => {
    expect(register).toContain('.RegisterTask(');
    expect(register).not.toContain('$env:TEMP');
    expect(register).not.toMatch(/\/XML['"],?\s*\$xmlPath/i);
  });

  it('requires exact weekly and monthly trigger cardinalities', () => {
    expect(register).toContain('$actualDays.Count -ne 1');
    expect(register).toContain('$actualWeeks.Count -ne 1');
    expect(register).toContain('$actualMonths.Count -ne 12');
    expect(register).toContain('$dayContainers.Count -ne 1');
    expect(register).toContain('Test-PCDoctorAllMonths');
  });
});

describe('PS5.1 native scheduler stderr handling', () => {
  it('keeps absent queries and failed query/create/delete results out of E_PS_UNHANDLED', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pcdoctor-schtasks-test-'));
    const harnessPath = path.join(directory, 'harness.ps1');
    const helperPath = path.join(process.cwd(), 'powershell', 'TaskSchedulerNative.ps1');
    const escapedHelperPath = helperPath.replace(/'/g, "''");
    writeFileSync(
      harnessPath,
      String.raw`$ErrorActionPreference = 'Stop'
. '${escapedHelperPath}'
$script:PCDoctorSchtasksPath = 'schtasks.exe'
function schtasks.exe {
  param([Parameter(ValueFromRemainingArguments = $true)][object[]]$Arguments)
  $verb = [string]$Arguments[0]
  Microsoft.PowerShell.Utility\Write-Error "mock stderr: $verb"
  $global:LASTEXITCODE = if ($verb -eq '/Query') { 1 } elseif ($verb -eq '/Create') { 5 } else { 7 }
}
$cases = @(
  (Invoke-PCDoctorSchtasks -Arguments @('/Query', '/TN', 'absent')),
  (Invoke-PCDoctorSchtasks -Arguments @('/Create', '/TN', 'failure')),
  (Invoke-PCDoctorSchtasks -Arguments @('/Delete', '/TN', 'failure', '/F'))
)
@{
  restored = [string]$ErrorActionPreference
  exit_codes = @($cases | ForEach-Object { $_.ExitCode })
  outputs = @($cases | ForEach-Object { $_.Output })
} | ConvertTo-Json -Depth 4 -Compress
`,
      'utf8',
    );

    try {
      const output = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', harnessPath],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      expect(output).not.toContain('E_PS_UNHANDLED');
      const result = JSON.parse(output) as { restored: string; exit_codes: number[]; outputs: string[] };
      expect(result.restored).toBe('Stop');
      expect(result.exit_codes).toEqual([1, 5, 7]);
      expect(result.outputs).toHaveLength(3);
      expect(result.outputs.every(value => value.includes('mock stderr'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('recognizes only not-found query output as absent and fails closed on other errors', () => {
    const helperPath = path.join(process.cwd(), 'powershell', 'TaskSchedulerNative.ps1');
    const escapedHelperPath = helperPath.replace(/'/g, "''");
    const command = [
      `. '${escapedHelperPath}'`,
      "$values = @{",
      "  missing = Test-PCDoctorTaskQueryAbsent ([pscustomobject]@{ ExitCode = 1; Output = 'ERROR: The system cannot find the file specified.' })",
      "  denied = Test-PCDoctorTaskQueryAbsent ([pscustomobject]@{ ExitCode = 1; Output = 'ERROR: Access is denied.' })",
      "  unknown = Test-PCDoctorTaskQueryAbsent ([pscustomobject]@{ ExitCode = -1; Output = 'native launch failed' })",
      "  present = Test-PCDoctorTaskQueryAbsent ([pscustomobject]@{ ExitCode = 0; Output = 'task xml' })",
      "}",
      '$values | ConvertTo-Json -Compress',
    ].join('\n');
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    expect(JSON.parse(output)).toEqual({
      missing: true,
      denied: false,
      unknown: false,
      present: false,
    });
  });
});

describe('manual firewall rollback exception', () => {
  it('is intentionally outside the calendar manifest and remains never-automatic', () => {
    expect(taskManifest.tasks.some(task => task.name === 'PCDoctor-Restore-Firewall')).toBe(false);
    expect(read('src/shared/automationCatalog.ts')).toMatch(/disable_firewall_temporarily[\s\S]{0,100}neverAutomatic\(\)/);
  });

  it('is preserved by manifest uninstall so an armed rollback cannot be stranded', () => {
    expect(read('powershell/Unregister-All-Tasks.ps1')).not.toContain('PCDoctor-Restore-Firewall');
    expect(read('powershell/actions/Disable-FirewallTemporary.ps1')).toContain("$taskName = 'PCDoctor-Restore-Firewall'");
  });
});

describe('active diagnostic scripts remain non-mutating at scheduled privilege', () => {
  it('Daily Quick Report suppresses Application event-source/event writes in Report mode', () => {
    const source = read('powershell/Invoke-PCDoctor.ps1');
    expect(source).toContain("$eventLogWritesEnabled = $Mode -ne 'Report'");
    expect(source).toMatch(/if \(\$eventLogWritesEnabled\) \{[\s\S]{0,500}New-EventLog/);
    expect(source).toMatch(/function Write-PCDEvent[\s\S]{0,300}if \(-not \$eventLogWritesEnabled\) \{ return \}/);
  });

  it('SMART collection is best-effort read-only for an ordinary interactive user', () => {
    const source = read('powershell/actions/Run-SmartCheck.ps1');
    expect(source).not.toContain("code = 'E_NOT_ADMIN'");
    expect(source).not.toContain('Run-SmartCheck requires administrator privileges');
    expect(source).toContain('$isAdmin');
  });
});
