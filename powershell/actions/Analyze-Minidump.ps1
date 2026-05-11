param([string]$DumpPath, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# If no dump path given, find the most recent .dmp
if (-not $DumpPath) {
    $minidumpDir = 'C:\Windows\Minidump'
    if (Test-Path $minidumpDir) {
        $latest = Get-ChildItem -Path $minidumpDir -Filter '*.dmp' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) { $DumpPath = $latest.FullName }
    }
}
if (-not $DumpPath -or -not (Test-Path $DumpPath)) {
    @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; message="No minidump found at $DumpPath (or C:\Windows\Minidump)"; dumps_available=0 } | ConvertTo-Json -Compress
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
    # v2.5.45: MS Store WinDbg install. The previous Get-ChildItem -Recurse
    # approach against C:\Program Files\WindowsApps\ returned nothing under
    # unelevated context because that directory is ACL-locked to
    # TrustedInstaller — enumeration is blocked, but point-lookup via
    # Test-Path on a specific file path still works. Use Get-AppxPackage
    # to discover the per-version InstallLocation (a documented API that
    # doesn't need filesystem enumeration), then Test-Path the known
    # subdirectory layouts.
    try {
        $pkg = Get-AppxPackage -Name 'Microsoft.WinDbg' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($pkg -and $pkg.InstallLocation) {
            $storeCandidates = @(
                (Join-Path $pkg.InstallLocation 'amd64\cdb.exe'),
                (Join-Path $pkg.InstallLocation 'x64\cdb.exe'),
                (Join-Path $pkg.InstallLocation 'cdb.exe')
            )
            $cdb = $storeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
        }
    } catch { }
}

if (-not $cdb) {
    # PATH fallback
    $where = (& where.exe cdb 2>$null | Select-Object -First 1)
    if ($where -and (Test-Path $where)) { $cdb = $where }
}

if (-not $cdb) {
    @{ success=$false; duration_ms=$sw.ElapsedMilliseconds; dump_path=$DumpPath; message='cdb.exe not found. Install the MS Store WinDbg (winget: Microsoft.WinDbg) or Windows SDK Debugging Tools.'; searched=$cdbCandidates + 'C:\Program Files\WindowsApps\Microsoft.WinDbg_*' } | ConvertTo-Json -Compress
    exit 0
}

# Run cdb with !analyze -v and capture output
$symbolPath = 'SRV*C:\SymCache*https://msdl.microsoft.com/download/symbols'
$cdbArgs = @('-z', $DumpPath, '-y', $symbolPath, '-c', '!analyze -v; q')
$output = & $cdb @cdbArgs 2>&1 | Out-String

# v2.5.46: detect dump-open failures BEFORE claiming success. Pre-2.5.46
# the script returned success=true based on cdb's exit code (which is 0
# even when the dump can't be opened); every interpretive field came back
# null and the renderer surfaced a misleading "analysis complete" toast.
# We now scan cdb output for known failure markers and surface a
# structured error so the caller knows the analysis didn't actually run.
$openFailureMarkers = @(
    'Could not open dump file',
    'Win32 error 0n5',                  # ERROR_ACCESS_DENIED (the v2.5.46 trigger)
    'Win32 error 0n2',                  # ERROR_FILE_NOT_FOUND (dump deleted mid-run)
    'Win32 error 0n32',                 # ERROR_SHARING_VIOLATION (another process has lock)
    'Debuggee initialization failed',
    'No system symbols found'           # SYM_FAILED at load — analyze never gets meaningful output
)
$dumpFailure = $null
foreach ($marker in $openFailureMarkers) {
    if ($output -match [regex]::Escape($marker)) {
        # Capture the matching line + 1 line of context for the message.
        $contextLines = ($output -split "`r?`n" | Where-Object { $_ -match [regex]::Escape($marker) } | Select-Object -First 1)
        $dumpFailure = "$contextLines".Trim()
        break
    }
}

if ($dumpFailure) {
    $hint = if ($dumpFailure -match 'Win32 error 0n5|Access is denied') {
        ' Re-run the action as Administrator — C:\Windows\Minidump\ is not readable by standard users.'
    } else { '' }
    @{
        success = $false
        code = 'E_DUMP_ANALYZE_FAILED'
        duration_ms = $sw.ElapsedMilliseconds
        dump_path = $DumpPath
        message = "cdb could not analyze the dump: $dumpFailure.$hint"
        full_output_tail = ($output.Trim() -split "`r?`n" | Select-Object -Last 40) -join "`n"
    } | ConvertTo-Json -Depth 4 -Compress
    exit 0
}

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
    dump_path = $DumpPath
    bug_check = $bugCheck
    bug_check_hex = $bugCheckHex
    probable_cause = $probableCause
    faulting_module = $faultingModule
    full_output_tail = ($output.Trim() -split "`r?`n" | Select-Object -Last 40) -join "`n"
    message = "Minidump analysis complete: $bugCheck"
} | ConvertTo-Json -Depth 4 -Compress
exit 0
