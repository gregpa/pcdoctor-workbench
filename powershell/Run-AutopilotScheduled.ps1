# Run-AutopilotScheduled.ps1 (v2.4.45)
#
# Dispatcher wrapper invoked by Windows Scheduled Tasks. Wraps an Autopilot
# action script, measures its duration, classifies its outcome, and appends
# a single JSON-Lines record to
#   C:\ProgramData\PCDoctor\logs\autopilot-scheduled-YYYYMMDD.log
# which `src/main/autopilotLogIngestor.ts` tails and inserts into the
# `autopilot_activity` table so the Autopilot page's LAST RUN column
# reflects actual scheduled-task runs.
#
# Outcome classification (matches insertAutopilotActivity):
#   exit 0 and no 'PCDOCTOR_ERROR:' in stdout -> auto_run
#   exit 0 but stdout contains 'PCDOCTOR_ERROR:' -> error
#   non-zero exit -> error
#
# Concurrency: two tasks can fire on the same minute. AppendAllText opens
# the file with a share mode that excludes other writers (FileShare.Read on
# .NET Framework / PowerShell 5.1; FileShare.None on .NET 6+ / pwsh 7). On
# IOException we try again -- up to 3 total attempts (initial + 2 retries)
# with a 100 ms backoff. More than enough for sub-ms append contention on a
# local ProgramData path; dispatcher telemetry is best-effort and we never
# propagate a write failure as a task failure.

param(
    [Parameter(Mandatory)] [string]$RuleId,
    [Parameter(Mandatory)] [ValidateRange(1,3)] [int]$Tier,
    [Parameter(Mandatory)] [string]$ActionScript
)

$ErrorActionPreference = 'Continue'

# Fixed paths (match renderPerfLog.ts RENDER_PERF_LOG_DIR convention).
$logDir = 'C:\ProgramData\PCDoctor\logs'
if (-not (Test-Path -LiteralPath $logDir)) {
    try { New-Item -ItemType Directory -Path $logDir -Force | Out-Null } catch { }
}
$today = Get-Date -Format 'yyyyMMdd'
$logFile = Join-Path $logDir "autopilot-scheduled-$today.log"
$MAX_LOG_BYTES = 50 * 1024 * 1024  # 50 MB soft cap (mirrors renderPerfLog)

# action_name = action script's file-name (e.g. 'Empty-RecycleBins.ps1').
# The Autopilot UI uses this alongside rule_id so a rename of the script is
# visible without breaking the LAST RUN lookup.
$actionName = if ([string]::IsNullOrEmpty($ActionScript)) { $null } else { [System.IO.Path]::GetFileName($ActionScript) }
$startTs = [DateTime]::UtcNow
$sw = [System.Diagnostics.Stopwatch]::StartNew()

$outcome = 'error'
$exitCode = 1
$message = ''
$bytesFreed = $null
$stdout = ''

try {
    if (-not (Test-Path -LiteralPath $ActionScript)) {
        $message = "ActionScript not found: $ActionScript"
    }
    else {
        # Invoke the action script as a child powershell process. -JsonOutput
        # is the convention all autopilot action scripts support. Capture
        # stdout (structured JSON) + stderr for classification.
        $psArgs = @(
            '-NoProfile'
            '-ExecutionPolicy', 'Bypass'
            '-File', $ActionScript
            '-JsonOutput'
        )
        $stdout = & powershell.exe @psArgs 2>&1 | Out-String
        $exitCode = $LASTEXITCODE

        if ($exitCode -eq 0 -and ($stdout -notmatch 'PCDOCTOR_ERROR:')) {
            $outcome = 'auto_run'
        }
        else {
            $outcome = 'error'
        }

        # Best-effort message + bytes_freed extraction. The autopilot action
        # convention is to emit a compact JSON object on stdout. We take the
        # last JSON line (scripts sometimes print banner lines above it).
        $jsonLine = $null
        foreach ($line in ($stdout -split "`r?`n")) {
            $t = $line.Trim()
            if ($t.StartsWith('{') -and $t.EndsWith('}')) { $jsonLine = $t }
        }
        if ($jsonLine) {
            try {
                $parsed = $jsonLine | ConvertFrom-Json -ErrorAction Stop
                if ($parsed.PSObject.Properties.Name -contains 'message' -and $parsed.message) {
                    $message = [string]$parsed.message
                }
                if ($parsed.PSObject.Properties.Name -contains 'bytes_freed' -and $null -ne $parsed.bytes_freed) {
                    $bytesFreed = [int64]$parsed.bytes_freed
                }
            } catch {
                # Malformed JSON from action script -> leave defaults.
            }
        }

        # PCDOCTOR_ERROR lines override message.
        $m = [regex]::Match($stdout, 'PCDOCTOR_ERROR:(\{[^\r\n]+\})')
        if ($m.Success) {
            try {
                $errObj = $m.Groups[1].Value | ConvertFrom-Json -ErrorAction Stop
                if ($errObj.PSObject.Properties.Name -contains 'message' -and $errObj.message) {
                    $message = [string]$errObj.message
                }
            } catch {
                $message = $m.Groups[1].Value
            }
        }

        if (-not $message) {
            if ($outcome -eq 'auto_run') { $message = 'ok' } else { $message = "exit=$exitCode" }
        }
    }
}
catch {
    $outcome = 'error'
    $message = $_.Exception.Message
}

$sw.Stop()

# Build the JSON-Lines record. Shape is frozen with the ingestor; see
# autopilotLogIngestor.ts parseAutopilotLogLine for consumer.
$record = [ordered]@{
    ts          = $startTs.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    rule_id     = $RuleId
    tier        = $Tier
    action_name = $actionName
    outcome     = $outcome
    duration_ms = [int]$sw.ElapsedMilliseconds
    message     = if ($message.Length -gt 500) { $message.Substring(0, 500) } else { $message }
}
if ($null -ne $bytesFreed) { $record['bytes_freed'] = $bytesFreed }
$line = ($record | ConvertTo-Json -Compress) + "`n"

# Soft size cap: skip writes once the day's log hits 50 MB. Caller's exit
# code is still preserved so the Windows Task Scheduler LAST-RESULT column
# remains meaningful even if we drop the telemetry line.
$shouldWrite = $true
try {
    if (Test-Path -LiteralPath $logFile) {
        $sz = (Get-Item -LiteralPath $logFile).Length
        if ($sz -ge $MAX_LOG_BYTES) { $shouldWrite = $false }
    }
} catch { }

if ($shouldWrite) {
    # Concurrent-append safety (see header comment). Up to 3 total tries
    # (initial + 2 retries) with 100 ms backoff.
    $attempt = 0
    while ($attempt -lt 3) {
        try {
            [System.IO.File]::AppendAllText($logFile, $line, [System.Text.UTF8Encoding]::new($false))
            break
        }
        catch [System.IO.IOException] {
            $attempt++
            if ($attempt -ge 3) { break }
            Start-Sleep -Milliseconds 100
        }
        catch {
            # Any other failure: bail. Never propagate -- telemetry must
            # never cause the Scheduled Task to report failure when the
            # wrapped action itself succeeded.
            break
        }
    }
}

# Relay the wrapped action script's stdout to our own stdout so the caller's
# `>> autopilot-YYYYMMDD.log 2>&1` redirect in Register-PCDoctorTask still
# captures debugging output unchanged. Our structured JSON record goes to
# autopilot-scheduled-YYYYMMDD.log above; the two logs coexist.
if ($stdout) {
    [Console]::Write($stdout)
}

# Exit with the action script's own exit code so Windows Task Scheduler's
# LAST RESULT column reflects what actually happened.
exit $exitCode
