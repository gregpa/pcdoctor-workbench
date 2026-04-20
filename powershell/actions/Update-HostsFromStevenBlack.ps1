<#
.SYNOPSIS
    Downloads the StevenBlack unified hosts list and merges it into the local
    hosts file while preserving user-authored entries.
.DESCRIPTION
    User entries are preserved between sentinel markers:
        # PCDOCTOR_USER_BEGIN
        ...user lines...
        # PCDOCTOR_USER_END
    On first run, any existing non-default content in hosts is captured into
    the user block. SHA256 of the remote list is persisted so subsequent runs
    can skip if unchanged. Always backs up the existing hosts file to
    C:\ProgramData\PCDoctor\rollback\hosts-<ts>.bak.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [string]$SourceUrl = 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts'
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
    @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' } | ConvertTo-Json -Compress
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

$hostsPath    = 'C:\Windows\System32\drivers\etc\hosts'
$stateDir     = 'C:\ProgramData\PCDoctor\state'
$rollbackDir  = 'C:\ProgramData\PCDoctor\rollback'
$shaFile      = Join-Path $stateDir 'hosts_sha.txt'
$userBegin    = '# PCDOCTOR_USER_BEGIN'
$userEnd      = '# PCDOCTOR_USER_END'
$blockBegin   = '# PCDOCTOR_STEVENBLACK_BEGIN'
$blockEnd     = '# PCDOCTOR_STEVENBLACK_END'

New-Item -Path $stateDir -ItemType Directory -Force | Out-Null
New-Item -Path $rollbackDir -ItemType Directory -Force | Out-Null

# Download remote list
$remoteText = $null
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $remoteText = Invoke-WebRequest -Uri $SourceUrl -UseBasicParsing -TimeoutSec 120 -ErrorAction Stop |
                  Select-Object -ExpandProperty Content
} catch {
    throw "Failed to download $SourceUrl : $($_.Exception.Message)"
}
if ([string]::IsNullOrWhiteSpace($remoteText)) { throw "Downloaded hosts file is empty." }

# SHA256 of downloaded content
$sha = [System.Security.Cryptography.SHA256]::Create()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($remoteText)
$hash = ($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join ''
$sha.Dispose()

$prevHash = $null
if (Test-Path $shaFile) { $prevHash = (Get-Content $shaFile -Raw -ErrorAction SilentlyContinue).Trim() }

# Backup current hosts
$ts = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $rollbackDir "hosts-$ts.bak"
Copy-Item -Path $hostsPath -Destination $backupPath -Force

if ($prevHash -eq $hash) {
    $sw.Stop()
    @{
        success       = $true
        no_op         = $true
        duration_ms   = $sw.ElapsedMilliseconds
        unchanged     = $true
        sha256        = $hash
        backup_path   = $backupPath
        domains_blocked = $null
        bytes_added   = 0
        message       = 'Already in desired state: StevenBlack list unchanged since last run; no edits made.'
    } | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

# Read current hosts
$currentRaw = ''
if (Test-Path $hostsPath) { $currentRaw = Get-Content -Path $hostsPath -Raw -ErrorAction SilentlyContinue }
if ($null -eq $currentRaw) { $currentRaw = '' }
$currentLines = $currentRaw -split "`r?`n"

# Extract existing user block, or migrate loose entries on first run.
$userLines = @()
$inUser = $false
$inStevenBlock = $false
$nonPcdoctorLines = @()

foreach ($line in $currentLines) {
    if ($line -eq $userBegin)    { $inUser = $true;  continue }
    if ($line -eq $userEnd)      { $inUser = $false; continue }
    if ($line -eq $blockBegin)   { $inStevenBlock = $true;  continue }
    if ($line -eq $blockEnd)     { $inStevenBlock = $false; continue }
    if ($inUser) { $userLines += $line; continue }
    if ($inStevenBlock) { continue }
    $nonPcdoctorLines += $line
}

# First-run migration: if we had no user block yet, treat any existing
# non-default custom mapping line as a user entry to preserve.
if ($userLines.Count -eq 0) {
    foreach ($l in $nonPcdoctorLines) {
        $t = $l.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        # Default Microsoft hosts has no uncommented mappings. Anything left is
        # user content worth preserving.
        $userLines += $l
    }
}

# Count domains in downloaded list (lines starting with 0.0.0.0 or 127.0.0.1)
$domainCount = 0
foreach ($l in ($remoteText -split "`r?`n")) {
    if ($l -match '^(0\.0\.0\.0|127\.0\.0\.1)\s+\S') { $domainCount++ }
}

# Compose new hosts file
$sb = New-Object System.Text.StringBuilder
[void]$sb.AppendLine('# Hosts file managed by PCDoctor Workbench')
[void]$sb.AppendLine("# Updated: $(Get-Date -Format u) from $SourceUrl")
[void]$sb.AppendLine('# Edits to preserve across updates belong between the USER_BEGIN/END markers.')
[void]$sb.AppendLine('')
[void]$sb.AppendLine($userBegin)
foreach ($ul in $userLines) { [void]$sb.AppendLine($ul) }
[void]$sb.AppendLine($userEnd)
[void]$sb.AppendLine('')
[void]$sb.AppendLine($blockBegin)
[void]$sb.Append($remoteText)
if (-not $remoteText.EndsWith("`n")) { [void]$sb.AppendLine('') }
[void]$sb.AppendLine($blockEnd)

$newContent = $sb.ToString()
$bytesBefore = if (Test-Path $hostsPath) { (Get-Item $hostsPath).Length } else { 0 }

# Write atomically: to temp, then Move-Item -Force replaces hosts
$tmp = [IO.Path]::Combine([IO.Path]::GetTempPath(), "pcdoctor-hosts-$ts.tmp")
[System.IO.File]::WriteAllText($tmp, $newContent, [System.Text.UTF8Encoding]::new($false))
Move-Item -Path $tmp -Destination $hostsPath -Force

$bytesAfter = (Get-Item $hostsPath).Length
$bytesAdded = [int64]($bytesAfter - $bytesBefore)

# Flush DNS so new entries take effect immediately.
try { & ipconfig.exe /flushdns | Out-Null } catch {}

# Persist SHA for next run
Set-Content -Path $shaFile -Value $hash -Encoding ASCII -Force

$sw.Stop()
$result = @{
    success         = $true
    duration_ms     = $sw.ElapsedMilliseconds
    sha256          = $hash
    previous_sha256 = $prevHash
    bytes_before    = $bytesBefore
    bytes_after     = $bytesAfter
    bytes_added     = $bytesAdded
    domains_blocked = $domainCount
    user_lines_preserved = $userLines.Count
    backup_path     = $backupPath
    message         = "Merged StevenBlack list ($domainCount domains blocked, preserved $($userLines.Count) user line(s))"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
