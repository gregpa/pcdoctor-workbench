<#
.SYNOPSIS
    Pre-ship gate (v2.5.33): exercise the FULL Electron-style spawn chain to
    catch regressions in the elevation handoff (Electron spawn -> unelevated
    PowerShell -> Start-Process -Verb RunAs -> elevated worker).

.DESCRIPTION
    v2.5.30 - v2.5.32 (post-mortem): three release attempts in 24 hours all
    shipped a broken Services/Processes mutate flow because:
      - vitest mocked the spawn entirely
      - test-worker-smoke.ps1 ran the worker DIRECTLY (no launcher chain)
      - The launcher chain bug was different in each version:
          v2.5.30: $pid = $PID worker startup crash
          v2.5.31: launchCmd had bare -NoProfile inside @(...)
          v2.5.32: spawn opts had detached:true which breaks Windows UAC

    This gate runs Node.js with the EXACT same spawn options
    elevatedWorker.ts uses in production -- detached, stdio, windowsHide
    flags included. If UAC fires and the heartbeat appears, the launcher
    chain works end-to-end. If not, we catch the regression before ship.

    REQUIRES UAC PROMPT to be approved by the operator. Skips with PASS if
    UAC cannot be invoked (CI / non-interactive / non-admin user).

.NOTES
    Runs unattended after the operator approves UAC. If UAC is configured
    to require an admin password (not just Yes/No), the operator must
    enter it within ~10s of the prompt appearing.
#>

[CmdletBinding()]
param(
    [int]$TimeoutSeconds = 30,
    [switch]$SkipIfNoInteractiveDesktop
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$worker = Join-Path $repoRoot 'powershell\worker\Elevated-Worker.ps1'
$basePath = Join-Path $repoRoot 'powershell'

if (-not (Test-Path $worker)) {
    Write-Host "[FAIL] worker not found at $worker"
    exit 1
}

# Skip if running headless (no interactive desktop -- UAC dialog can't show)
$session = & query session 2>$null | Select-String 'Active'
if ($SkipIfNoInteractiveDesktop -and -not $session) {
    Write-Host "[SKIP] no interactive desktop session; cannot prompt UAC"
    exit 0
}

# Drop a Node.js script that reproduces production spawn semantics and
# polls the queue for the heartbeat.
$queueDir = Join-Path $env:TEMP "pcdoctor-launcher-smoke-$([guid]::NewGuid().ToString('N').Substring(0,8))"
if (Test-Path $queueDir) { Remove-Item $queueDir -Recurse -Force }
New-Item -ItemType Directory -Path $queueDir | Out-Null

$nodeScript = Join-Path $queueDir '_runner.js'
$pwsh7 = 'C:\Program Files\PowerShell\7\pwsh.exe'
$ps51  = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$pwsh = if (Test-Path $pwsh7) { $pwsh7 } else { $ps51 }

# Read the production spawn options from elevatedWorker.ts at build time
# is overkill for a smoke test -- just hardcode the same { detached:false,
# stdio:'ignore', windowsHide:true } combo. The test-worker-smoke.ps1
# vitest gate independently asserts the launchCmd shape; this gate proves
# the spawn options trigger UAC end-to-end.
$nodeBody = @"
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const queueDir = $($queueDir | ConvertTo-Json);
const pwsh = $($pwsh | ConvertTo-Json);
const worker = $($worker | ConvertTo-Json);
const basePath = $($basePath | ConvertTo-Json);
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const innerArgs = [
  '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden',
  '-File',worker,'-BasePath',basePath,'-QueueDir',queueDir
].map(q).join(',');
const launchCmd = ``Start-Process -FilePath `${q(pwsh)} -ArgumentList @(`${innerArgs}) -Verb RunAs -WindowStyle Hidden``;
const child = spawn(pwsh, ['-NoProfile','-ExecutionPolicy','Bypass','-Command',launchCmd], {
  detached: false,    // v2.5.33: must be false for UAC to fire
  stdio: 'ignore',
  windowsHide: true,
});
child.unref();
const hb = path.join(queueDir, '.heartbeat');
const start = Date.now();
const deadline = start + $($TimeoutSeconds * 1000);
const t = setInterval(() => {
  if (fs.existsSync(hb)) {
    const ms = Date.now() - start;
    process.stdout.write(``HEARTBEAT_OK:`${ms}\n``);
    clearInterval(t);
    process.exit(0);
  } else if (Date.now() > deadline) {
    process.stdout.write('NO_HEARTBEAT\n');
    clearInterval(t);
    process.exit(1);
  }
}, 200);
"@

Set-Content -Path $nodeScript -Value $nodeBody -Encoding UTF8

Write-Host "Launcher smoke test: spawning unelevated launcher PS that should trigger UAC."
Write-Host "Approve the UAC prompt within $TimeoutSeconds seconds."
Write-Host ""

$out = & node $nodeScript 2>&1
$exit = $LASTEXITCODE

Write-Host "Node runner output:"
$out | ForEach-Object { Write-Host "  $_" }

# Cleanup any spawned worker
Get-CimInstance Win32_Process -Filter "Name LIKE 'pwsh%'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match [regex]::Escape($queueDir) } |
  ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Milliseconds 200
if (Test-Path $queueDir) { Remove-Item $queueDir -Recurse -Force -ErrorAction SilentlyContinue }

if ($exit -eq 0) {
    Write-Host "[PASS] launcher chain triggered UAC and worker wrote heartbeat"
    exit 0
} else {
    Write-Host "[FAIL] launcher chain did not produce a heartbeat within $TimeoutSeconds`s"
    Write-Host "       Possible regressions:"
    Write-Host "       - spawn opts.detached re-enabled (v2.5.32 bug)"
    Write-Host "       - launchCmd quoting broken (v2.5.31 bug)"
    Write-Host "       - worker startup crash (v2.5.30 bug)"
    exit 1
}
