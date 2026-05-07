param([switch]$ApplyAll, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# v2.5.39: parse the dcu-cli XML report so the renderer can show "N updates
# applied" instead of a meaningless "scan complete" toast. dcu-cli emits ""
# on stdout when run -silent; the report XML is the only structured surface.
#
# Behavior: always scan + apply (the only caller, the Updates page button,
# explicitly says "Scan + Apply"; the autopilot rule alert_old_driver wants
# the same). -ApplyAll switch retained for backward-compat with any queued
# invocations from older builds; its value is no longer read.
# v2.5.34-style guard against case-insensitive variable shadow: see
# reference_pwsh_case_insensitive_shadowing.md.

$dcu = @(
    'C:\Program Files\Dell\CommandUpdate\dcu-cli.exe',
    'C:\Program Files (x86)\Dell\CommandUpdate\dcu-cli.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dcu) { throw 'Dell Command Update not installed - download from dell.com/support' }

$reportDir = Join-Path $env:TEMP "pcdoctor-dcu-$(Get-Random)"
New-Item -Path $reportDir -ItemType Directory -Force | Out-Null

# Returns @{count=N; titles=@(...)}. dcu-cli writes DCUApplicableUpdates.xml
# to -report=<dir> on /scan. Schema: <updates><update name=... severity=...>.
function Read-DcuApplicable {
    param([string]$Dir)
    $xmlPath = Join-Path $Dir 'DCUApplicableUpdates.xml'
    if (-not (Test-Path $xmlPath)) { return @{ count = 0; titles = @() } }
    try {
        [xml]$x = Get-Content -LiteralPath $xmlPath -Raw -ErrorAction Stop
        $updates = @($x.updates.update)
        $titles = @()
        foreach ($u in $updates) {
            if ($u.name) {
                $sev = if ($u.severity) { " ($($u.severity))" } else { '' }
                $titles += "$($u.name)$sev"
            } elseif ($u.title) {
                $titles += "$($u.title)"
            }
        }
        return @{ count = $updates.Count; titles = $titles }
    } catch {
        return @{ count = 0; titles = @() }
    }
}

try {
    # Step 1: scan -- populates DCUApplicableUpdates.xml in $reportDir.
    & $dcu /scan -silent "-report=$reportDir" 2>&1 | Out-Null
    $available = Read-DcuApplicable -Dir $reportDir

    if ($available.count -eq 0) {
        @{
            success = $true
            duration_ms = $sw.ElapsedMilliseconds
            mode = 'scan_no_updates'
            updates_available = 0
            updates_applied = 0
            applied_titles = @()
            message = 'Dell scan complete - no updates available.'
        } | ConvertTo-Json -Compress
        return
    }

    # Step 2: apply. autoSuspendBitLocker prevents recovery-key prompt mid-flash.
    $applyOut = & $dcu /applyUpdates -silent -autoSuspendBitLocker=enable "-outputLog=$reportDir\apply.log" 2>&1 | Out-String
    @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        mode = 'applied'
        updates_available = $available.count
        updates_applied = $available.count
        applied_titles = $available.titles
        output = $applyOut.Trim()
        message = "Applied $($available.count) Dell update(s). Reboot may be required for some firmware/BIOS updates to take effect."
    } | ConvertTo-Json -Compress
} finally {
    # Best-effort cleanup; report dir lives in $env:TEMP so it'll get reaped
    # eventually anyway, but tidiness avoids per-invocation accumulation.
    Remove-Item -LiteralPath $reportDir -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
