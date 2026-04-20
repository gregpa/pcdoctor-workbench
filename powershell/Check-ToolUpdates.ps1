<#
.SYNOPSIS
    Query winget for available upgrades and write a JSON cache at
    C:\ProgramData\PCDoctor\tools\updates.json. The Workbench reads the
    cache to flag tool tiles with "Update available -> v..." badges and
    drive the Upgrade / Upgrade All buttons.
.NOTES
    Intended to run weekly via scheduled task. Doesn't upgrade anything -
    just reports. Also safe to run as user: winget upgrade works without
    admin for detection (upgrade itself may need admin).
#>
param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Continue'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()

if ($DryRun) { @{success=$true;dry_run=$true;upgrades=@()} | ConvertTo-Json -Compress; exit 0 }

$cacheDir = 'C:\ProgramData\PCDoctor\tools'
if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
$cachePath = Join-Path $cacheDir 'updates.json'

# winget may not be available (older Win10). Fail gracefully.
$winget = (Get-Command winget -ErrorAction SilentlyContinue).Source
if (-not $winget) {
    @{ success=$true; duration_ms=$sw.ElapsedMilliseconds; winget_available=$false;
       upgrades=@(); count=0; checked_at=(Get-Date).ToString('s');
       message='winget not available on this machine' } |
        ConvertTo-Json -Compress | Tee-Object -FilePath $cachePath | Out-Null
    @{ success=$true; winget_available=$false; count=0; message='winget not available' } |
        ConvertTo-Json -Compress
    exit 0
}

# Run winget upgrade. --include-unknown surfaces apps whose current version
# couldn't be detected; --accept-source-agreements skips the first-run prompt.
$out = & winget upgrade --include-unknown --accept-source-agreements 2>&1 | Out-String
$exit = $LASTEXITCODE

# Parse the tabular output. Column positions are locale-sensitive; we
# anchor on the underline row of '-' characters that winget prints between
# header and data.
$lines = $out -split "`r?`n"
$headerLineIdx = -1
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\-{5,}') { $headerLineIdx = $i; break }
}

$upgrades = @()
if ($headerLineIdx -ge 1) {
    # The header line is the row above the dashes. Column widths are
    # derived from the dash groups.
    $dashLine = $lines[$headerLineIdx]
    $headerLine = $lines[$headerLineIdx - 1]
    $colStarts = @()
    $inGap = $true
    for ($c = 0; $c -lt $dashLine.Length; $c++) {
        if ($dashLine[$c] -eq '-') {
            if ($inGap) { $colStarts += $c; $inGap = $false }
        } else {
            $inGap = $true
        }
    }
    # Header field names
    $headers = @()
    for ($h = 0; $h -lt $colStarts.Count; $h++) {
        $start = $colStarts[$h]
        $end = if ($h -lt $colStarts.Count - 1) { $colStarts[$h + 1] } else { $headerLine.Length }
        $name = $headerLine.Substring($start, [Math]::Min($end - $start, $headerLine.Length - $start)).Trim()
        $headers += $name
    }

    # Data rows - until the next blank line or footer
    for ($r = $headerLineIdx + 1; $r -lt $lines.Count; $r++) {
        $row = $lines[$r]
        if ($row -match '^\s*$') { break }
        # Skip footer lines like "23 upgrades available."
        if ($row -match '^\d+\s+upgrade') { break }
        if ($row -match 'upgrade') { continue }
        $cells = @()
        for ($h = 0; $h -lt $colStarts.Count; $h++) {
            $start = $colStarts[$h]
            if ($start -ge $row.Length) { $cells += ''; continue }
            $end = if ($h -lt $colStarts.Count - 1) { $colStarts[$h + 1] } else { $row.Length }
            $cells += $row.Substring($start, [Math]::Min($end - $start, $row.Length - $start)).Trim()
        }
        # Map to named fields. Typical columns: Name, Id, Version, Available, Source
        $nameIdx      = [Array]::IndexOf($headers, 'Name')
        $idIdx        = [Array]::IndexOf($headers, 'Id')
        $versionIdx   = [Array]::IndexOf($headers, 'Version')
        $availableIdx = [Array]::IndexOf($headers, 'Available')
        $sourceIdx    = [Array]::IndexOf($headers, 'Source')
        $entry = @{
            name      = if ($nameIdx -ge 0 -and $nameIdx -lt $cells.Count) { $cells[$nameIdx] } else { '' }
            winget_id = if ($idIdx -ge 0 -and $idIdx -lt $cells.Count) { $cells[$idIdx] } else { '' }
            current   = if ($versionIdx -ge 0 -and $versionIdx -lt $cells.Count) { $cells[$versionIdx] } else { '' }
            available = if ($availableIdx -ge 0 -and $availableIdx -lt $cells.Count) { $cells[$availableIdx] } else { '' }
            source    = if ($sourceIdx -ge 0 -and $sourceIdx -lt $cells.Count) { $cells[$sourceIdx] } else { '' }
        }
        if ($entry.winget_id -and $entry.available) { $upgrades += $entry }
    }
}

$sw.Stop()
$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    winget_available = $true
    exit_code = $exit
    checked_at = (Get-Date).ToString('s')
    count = $upgrades.Count
    upgrades = $upgrades
    message = "$($upgrades.Count) upgrade(s) available"
}
$result | ConvertTo-Json -Depth 5 -Compress | Tee-Object -FilePath $cachePath | Out-Null
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
