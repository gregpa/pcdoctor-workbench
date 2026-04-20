param([string]$Dump_Path, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# If no dump path given, find the most recent .dmp
if (-not $Dump_Path) {
    $minidumpDir = 'C:\Windows\Minidump'
    if (Test-Path $minidumpDir) {
        $latest = Get-ChildItem -Path $minidumpDir -Filter '*.dmp' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) { $Dump_Path = $latest.FullName }
    }
}
if (-not $Dump_Path -or -not (Test-Path $Dump_Path)) {
    @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; message="No minidump found at $Dump_Path (or C:\Windows\Minidump)"; dumps_available=0 } | ConvertTo-Json -Compress
    exit 0
}

# Find cdb.exe (WinDbg console debugger).
# Search order: Windows SDK Debuggers, standalone Debugging Tools, MS Store WinDbg
# (the Store app at C:\Program Files\WindowsApps\Microsoft.WinDbg_*\amd64\cdb.exe
# is version-suffixed, so we use Get-ChildItem glob), finally PATH.
$cdbCandidates = @(
    'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe',
    'C:\Program Files\Windows Kits\10\Debuggers\x64\cdb.exe',
    'C:\Program Files\Debugging Tools for Windows (x64)\cdb.exe'
)
$cdb = $cdbCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $cdb) {
    # MS Store WinDbg install (per-package-version path)
    $storeHit = Get-ChildItem -Path 'C:\Program Files\WindowsApps\Microsoft.WinDbg_*' -Filter 'cdb.exe' -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.DirectoryName -match '\\amd64$' -or $_.DirectoryName -match '\\x64$' } |
                Sort-Object { $_.DirectoryName } -Descending |
                Select-Object -First 1
    if ($storeHit) { $cdb = $storeHit.FullName }
}

if (-not $cdb) {
    # PATH fallback
    $where = (& where.exe cdb 2>$null | Select-Object -First 1)
    if ($where -and (Test-Path $where)) { $cdb = $where }
}

if (-not $cdb) {
    @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; dump_path=$Dump_Path; message='cdb.exe not found. Install the MS Store WinDbg (winget: Microsoft.WinDbg) or Windows SDK Debugging Tools.'; searched=$cdbCandidates + 'C:\Program Files\WindowsApps\Microsoft.WinDbg_*' } | ConvertTo-Json -Compress
    exit 0
}

# Run cdb with !analyze -v and capture output
$symbolPath = 'SRV*C:\SymCache*https://msdl.microsoft.com/download/symbols'
$cdbArgs = @('-z', $Dump_Path, '-y', $symbolPath, '-c', '!analyze -v; q')
$output = & $cdb @cdbArgs 2>&1 | Out-String

# Extract key fields
$bugCheck = $null; $bugCheckHex = $null; $probableCause = $null; $faultingModule = $null
if ($output -match 'BUGCHECK_CODE:\s*([0-9a-fA-Fx]+)') { $bugCheckHex = $Matches[1] }
if ($output -match 'BUGCHECK_STR:\s*(\S+)') { $bugCheck = $Matches[1] }
if ($output -match 'MODULE_NAME:\s*(\S+)') { $faultingModule = $Matches[1] }
if ($output -match 'PROBABLY_CAUSED_BY:\s*(.+?)(?:\r?\n|$)') { $probableCause = $Matches[1].Trim() }
if (-not $probableCause -and $output -match 'FAILURE_BUCKET_ID:\s*(\S+)') { $probableCause = $Matches[1] }

@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    dump_path = $Dump_Path
    bug_check = $bugCheck
    bug_check_hex = $bugCheckHex
    probable_cause = $probableCause
    faulting_module = $faultingModule
    full_output_tail = ($output.Trim() -split "`r?`n" | Select-Object -Last 40) -join "`n"
    message = "Minidump analysis complete: $bugCheck"
} | ConvertTo-Json -Depth 4 -Compress
exit 0
