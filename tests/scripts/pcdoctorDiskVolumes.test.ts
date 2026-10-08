// @vitest-environment node
//
// Invoke-PCDoctor.ps1 disk-space check: a volume with Size 0/null (H:) or a
// locked BitLocker volume (B: SecureDrive) used to report as "100% full".
// This loads ONLY Split-PCDoctorVolumes from the script via the AST (the same
// pattern as scripts/test-worker-smoke.ps1) and feeds it fake volumes, so no
// real volume or BitLocker cmdlet is touched.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = path.join(process.cwd(), 'powershell', 'Invoke-PCDoctor.ps1');

const harness = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile('${scriptPath.replace(/'/g, "''")}', [ref]$tokens, [ref]$errors)
if ($errors.Count -gt 0) { throw 'Invoke-PCDoctor.ps1 does not parse' }
$def = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Split-PCDoctorVolumes' }, $true))[0]
if (-not $def) { throw 'Split-PCDoctorVolumes missing' }
Invoke-Expression $def.Extent.Text
$volumes = @(
    [pscustomobject]@{ DriveLetter = 'C'; Size = [uint64]1000GB; SizeRemaining = [uint64]400GB },
    [pscustomobject]@{ DriveLetter = 'H'; Size = [uint64]0; SizeRemaining = [uint64]0 },
    [pscustomobject]@{ DriveLetter = 'B'; Size = [uint64]500GB; SizeRemaining = [uint64]0 }
)
$r = Split-PCDoctorVolumes -Volumes $volumes -LockedDriveLetters @('B')
[ordered]@{
    measured = @($r.measured | ForEach-Object { "$($_.DriveLetter)" })
    skipped  = @($r.skipped | ForEach-Object { [ordered]@{ drive = $_.drive; reason = $_.reason; status = $_.status } })
} | ConvertTo-Json -Depth 4 -Compress
`;

describe('Invoke-PCDoctor.ps1 disk volume split', () => {
  it('measures only the normal volume; size-0 and locked volumes are skipped', () => {
    const output = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', harness],
      { encoding: 'utf8', windowsHide: true },
    ).trim();

    expect(JSON.parse(output)).toEqual({
      measured: ['C'],
      skipped: [
        { drive: 'H:', reason: 'no_size', status: 'skipped (locked / no size)' },
        { drive: 'B:', reason: 'locked', status: 'skipped (locked / no size)' },
      ],
    });
  });
});
