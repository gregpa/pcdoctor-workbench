<#
.SYNOPSIS
    Removes leftover Feature Update folders (C:\$Windows.~BT, $Windows.~WS, Windows.old)
    once they are older than 10 days.
.DESCRIPTION
    These are staging folders left behind after a Windows feature update. They
    can be several GB. Age check prevents deleting a staging folder that
    belongs to an in-progress update.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [int]$MinAgeDays = 10
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
        stack   = $_.ScriptStackTrace
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) {
    # In dry-run, still inspect + report what WOULD be deleted. These folders
    # have Hidden+System attributes so -Force is required; they're also ACL-
    # protected which is why Get-ChildItem under them may be partially empty.
    $candidates = @('C:\$Windows.~BT','C:\$Windows.~WS','C:\Windows.old')
    $plan = @()
    foreach ($p in $candidates) {
        if ([System.IO.Directory]::Exists($p)) {
            $age = $null
            $size = 0L
            try {
                $di = [System.IO.DirectoryInfo]::new($p)
                $age = (New-TimeSpan -Start $di.CreationTime -End (Get-Date)).Days
            } catch {}
            try {
                $size = (Get-ChildItem -LiteralPath $p -Recurse -Force -File -ErrorAction SilentlyContinue |
                         Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
                if ($null -eq $size) { $size = 0 }
            } catch {}
            $plan += @{ path = $p; age_days = $age; bytes = $size; eligible = ($age -ne $null -and $age -ge $MinAgeDays) }
        }
    }
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun'; plan = $plan; min_age_days = $MinAgeDays } | ConvertTo-Json -Depth 5 -Compress
    exit 0
}

# --- Admin pre-check ---
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $errRecord = @{ code = 'E_NOT_ADMIN'; message = 'This action requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$targets = @('C:\$Windows.~BT','C:\$Windows.~WS','C:\Windows.old')
$deleted = @()
$skipped = @()
$totalFreed = 0L

foreach ($path in $targets) {
    if (-not [System.IO.Directory]::Exists($path)) {
        $skipped += @{ path = $path; reason = 'not_present' }
        continue
    }
    $item = [System.IO.DirectoryInfo]::new($path)
    $age = (New-TimeSpan -Start $item.CreationTime -End (Get-Date)).Days
    if ($age -lt $MinAgeDays) {
        $skipped += @{ path = $path; reason = 'too_young'; age_days = $age; min_age_days = $MinAgeDays }
        continue
    }
    $size = 0L
    try {
        $size = (Get-ChildItem -LiteralPath $path -Recurse -Force -File -ErrorAction SilentlyContinue |
                 Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum
        if ($null -eq $size) { $size = 0 }
    } catch {}

    # Windows.old and $Windows.~* have system ACLs. Use takeown + icacls to
    # unlock, then remove. Wrap each in try so one failure doesn't abort.
    try {
        $null = & takeown.exe /F $path /R /D Y 2>&1
        $null = & icacls.exe $path /grant "*S-1-5-32-544:F" /T /C /Q 2>&1
        Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
        $deleted += @{ path = $path; bytes = $size; age_days = $age }
        $totalFreed += $size
    } catch {
        $skipped += @{ path = $path; reason = 'delete_failed'; error = $_.Exception.Message }
    }
}

$sw.Stop()
$result = @{
    success        = $true
    duration_ms    = $sw.ElapsedMilliseconds
    bytes_freed    = $totalFreed
    paths_deleted  = $deleted
    paths_skipped  = $skipped
    min_age_days   = $MinAgeDays
    message        = "Reclaimed $([math]::Round($totalFreed/1GB,2)) GB by removing $($deleted.Count) leftover folder(s)"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
