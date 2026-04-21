<#
.SYNOPSIS
    Scrubs stale entries from HKLM:\SYSTEM\CurrentControlSet\Control\Session
    Manager\PendingFileRenameOperations so the "Pending Reboot" detector
    stops flagging no-ops that will never complete.
.DESCRIPTION
    Removes entries where EITHER:
      - The source file no longer exists (rename target is moot), OR
      - The source path matches a known-stale pattern (Chrome\Temp,
        Edge\Temp, Firefox staging, Gaming Services proxy DLL).

    PendingFileRenameOperations is a flat REG_MULTI_SZ where every rename
    takes TWO entries: source then target (target is empty for delete).
    Removing one side without the other corrupts the queue — we always
    operate on pairs.

    Requires admin. Idempotent. Safe to run while browsers are open: we
    only strip entries whose source file is gone OR is inside a staging
    temp dir that the browser itself would have re-created on next
    launch if it still needed the file.

    v2.4.6: introduced to clear the perpetual PendingFileRename alert
    caused by Chrome's updater leaving `old_chrome.exe` marked for
    delete-on-reboot when Chrome is running at reboot time.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
    } | ConvertTo-Json -Depth 3 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# --- Admin pre-check ---
$currentId = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object System.Security.Principal.WindowsPrincipal($currentId)
if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $errRecord = @{ code = 'E_NOT_ADMIN'; message = 'This action requires administrator privileges.' } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$regPath = 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager'
$regName = 'PendingFileRenameOperations'

# Patterns for "definitely safe to strip" source paths. If the source
# matches, we drop the pair even if the file still exists (because the
# rename is a browser-updater leftover that will re-stage itself as
# needed).
#
# Pattern notes:
#   - "(?:\\|$)" matches either a subfolder delimiter OR end-of-string,
#     so both `\Chrome\Temp\subfolder\old_chrome.exe` AND the bare
#     `\Chrome\Temp` directory entry are caught. Without the end anchor
#     the bare-dir entry was silently kept and the Pending Reboot flag
#     stayed after a partial scrub (observed on live system 2026-04-21).
$benignPatterns = @(
    '\\Google\\Chrome\\Temp(?:\\|$)',
    '\\Microsoft\\Edge\\Temp(?:\\|$)',
    '\\Mozilla Firefox\\updated(?:\\|$)',
    '\\Mozilla Firefox\\[0-9a-f-]+(?:\\|$)',
    'gamingservicesproxy_e\.dll',
    'gamingservices_e\.dll'
)

$raw = $null
try {
    $raw = (Get-ItemProperty -Path $regPath -Name $regName -EA Stop).$regName
} catch {
    # No pending renames = nothing to do. This is the healthy state.
    $result = @{
        success       = $true
        no_op         = $true
        duration_ms   = $sw.ElapsedMilliseconds
        total_entries = 0
        kept          = 0
        removed       = 0
        removed_pairs = @()
        message       = 'No pending file-rename operations queued.'
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
    exit 0
}

# PendingFileRenameOperations is REG_MULTI_SZ treated as pairs:
#   [0] source  [1] target (empty for delete)
#   [2] source  [3] target
#   ...
# Strip empty trailing entries that Windows pads with.
$entries = @($raw | Where-Object { $_ -ne $null })

# Defensive: if count is odd, keep everything (don't risk corrupting).
if (($entries.Count % 2) -ne 0) {
    $err = @{
        code='E_PFRO_ODD_COUNT'
        message="PendingFileRenameOperations has an odd entry count ($($entries.Count)). Refusing to modify."
    } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$err"
    exit 1
}

$kept = @()
$removedPairs = @()

for ($i = 0; $i -lt $entries.Count; $i += 2) {
    $src = $entries[$i]
    $dst = $entries[$i + 1]

    # Normalize the "*1\??\" prefix Windows uses on the source entry.
    $srcNormalized = $src
    if ($src -match '^\*?\d?\\\?\?\\(.+)$') {
        $srcNormalized = $Matches[1]
    }

    $fileExists = $false
    if ($srcNormalized) {
        try { $fileExists = Test-Path -LiteralPath $srcNormalized -EA SilentlyContinue } catch { $fileExists = $false }
    }

    $isBenignPattern = $false
    foreach ($pat in $benignPatterns) {
        if ($src -match $pat) { $isBenignPattern = $true; break }
    }

    $shouldRemove = (-not $fileExists) -or $isBenignPattern

    if ($shouldRemove) {
        $removedPairs += @{
            source        = $src
            target        = $dst
            reason        = if (-not $fileExists) { 'source_missing' } else { 'benign_pattern' }
            source_exists = $fileExists
        }
    } else {
        $kept += $src
        $kept += $dst
    }
}

if ($DryRun) {
    $result = @{
        success       = $true
        dry_run       = $true
        duration_ms   = $sw.ElapsedMilliseconds
        total_entries = $entries.Count / 2
        kept          = $kept.Count / 2
        removed       = $removedPairs.Count
        removed_pairs = $removedPairs
        message       = "DryRun: would remove $($removedPairs.Count) stale pair(s), keep $($kept.Count / 2)."
    }
    if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
    exit 0
}

# Write the filtered queue back. If everything is stale, delete the
# value entirely so the "Pending Reboot" flag clears immediately.
if ($kept.Count -eq 0) {
    Remove-ItemProperty -Path $regPath -Name $regName -Force -EA Stop
} elseif ($kept.Count -ne $entries.Count) {
    Set-ItemProperty -Path $regPath -Name $regName -Value ([string[]]$kept) -Type MultiString -Force -EA Stop
}
# If nothing was removed, don't touch the registry at all.

$sw.Stop()
$result = @{
    success       = $true
    no_op         = ($removedPairs.Count -eq 0)
    duration_ms   = $sw.ElapsedMilliseconds
    total_entries = $entries.Count / 2
    kept          = $kept.Count / 2
    removed       = $removedPairs.Count
    removed_pairs = $removedPairs
    message       = if ($removedPairs.Count -eq 0) {
        "No stale entries found. $($entries.Count / 2) pair(s) remain."
    } elseif ($kept.Count -eq 0) {
        "Removed all $($removedPairs.Count) pair(s) (queue emptied). Pending Reboot flag should clear on next scan."
    } else {
        "Removed $($removedPairs.Count) stale pair(s), kept $($kept.Count / 2)."
    }
}
if ($JsonOutput) { $result | ConvertTo-Json -Depth 5 -Compress } else { $result | ConvertTo-Json -Depth 5 }
exit 0
