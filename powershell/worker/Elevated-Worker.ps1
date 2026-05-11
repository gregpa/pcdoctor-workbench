<#
.SYNOPSIS
    Long-lived elevated worker for batched-UAC PCDoctor actions (v2.5.30).

.DESCRIPTION
    The Electron main process (low integrity) cannot pipe stdin to an
    elevated child (high integrity) because of Windows UIPI. This worker
    sidesteps the restriction with a file-based command queue:

      %LOCALAPPDATA%\PCDoctor\worker-queue\
        <id>.cmd.json     <- unelevated main writes a command
        <id>.result.json  <- elevated worker writes the result

    Main process workflow:
      1. spawn this worker once via `Start-Process -Verb RunAs` (UAC prompt)
      2. worker writes .heartbeat with its PID + last_seen timestamp
      3. main writes <id>.cmd.json, polls for <id>.result.json
      4. main reads + deletes both files

    Worker workflow:
      1. ensure queue dir exists
      2. tick loop:
         - update heartbeat
         - for each *.cmd.json: dispatch by action, write result, delete cmd
         - exit if idle timeout exceeded

    Idle timeout (default 600s) keeps the worker around for the duration
    of a typical Services-page editing session, then lets it die so the
    next session re-prompts for UAC fresh (auditability).

.PARAMETER BasePath
    Absolute path to the powershell/ directory in either ProgramData
    (canonical, post-installer) or the app bundle's resources/powershell/
    (fresh-install fallback before bundle-sync runs). Action scripts are
    resolved as Join-Path $BasePath 'actions/<Name>.ps1'.

.PARAMETER QueueDir
    Absolute path to the queue directory. Defaults to
    "$env:LOCALAPPDATA\PCDoctor\worker-queue".

.PARAMETER IdleTimeoutSeconds
    Seconds with no command before the worker exits. Default 600 (10 min).

.PARAMETER PollIntervalMs
    Milliseconds between queue scans. Default 100.

.NOTES
    PowerShell 5.1 compatible (no ?? null-coalesce, no ?. null-conditional,
    no ternary). Verified by scripts/test-ps51-syntax.ps1.

    Action allowlist is enforced HERE, not in the cmd files. A malicious
    cmd file with action='nuke-system32' is dropped; only the actions in
    $ActionMap below are dispatchable. This is the security boundary.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$BasePath,

    [string]$QueueDir = "$env:LOCALAPPDATA\PCDoctor\worker-queue",

    [int]$IdleTimeoutSeconds = 600,

    [int]$PollIntervalMs = 100
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Action allowlist. Each entry maps an action name to a script-relative path
# under $BasePath. The worker refuses any action not on this list.
#
# Dispatchers receive the cmd's `params` hashtable and return a hashtable
# that becomes the result file's `data` field on success. They throw on
# failure; the trap converts to a structured error in the result file.
# ---------------------------------------------------------------------------
$ActionMap = @{
    'set-service-startup' = 'actions\Set-ServiceStartup.ps1'
    'stop-service'        = 'actions\Stop-Service.ps1'
    'start-service'       = 'actions\Start-Service.ps1'
    'restart-service'     = 'actions\Restart-Service.ps1'
    'kill-process'        = 'actions\Kill-Process.ps1'
    'set-process-priority'= 'actions\Set-ProcessPriority.ps1'
    'set-process-affinity'= 'actions\Set-ProcessAffinity.ps1'
    'suspend-process'     = 'actions\Suspend-Process.ps1'
    'resume-process'      = 'actions\Resume-Process.ps1'
}

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
if (-not (Test-Path $QueueDir)) {
    New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null
}

$heartbeatFile = Join-Path $QueueDir '.heartbeat'
# $PID is a read-only automatic variable; assigning to $pid (case-insensitive
# alias) crashes the worker on startup. Use a distinct name.
$workerPid = $PID
$startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()

function Update-Heartbeat {
    $hb = @{
        pid        = $workerPid
        started_at = $startedAt
        last_seen  = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        version    = '2.5.44'
    } | ConvertTo-Json -Compress
    # Best-effort write: heartbeat is informational, never block the worker
    # if a transient AV scan locks the file.
    try { $hb | Set-Content -Path $heartbeatFile -Encoding UTF8 -ErrorAction Stop } catch {}
}

Update-Heartbeat

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------
function Invoke-CmdAction {
    param(
        [Parameter(Mandatory=$true)] $cmd
    )
    $action = "$($cmd.action)"
    if (-not $ActionMap.ContainsKey($action)) {
        throw [System.InvalidOperationException]::new("Unknown action: $action")
    }
    $rel = $ActionMap[$action]
    $scriptPath = Join-Path $BasePath $rel
    if (-not (Test-Path $scriptPath)) {
        throw [System.IO.FileNotFoundException]::new("Action script not found: $scriptPath")
    }

    # Build splat-args from params. Each entry becomes a -Name Value pair.
    # Booleans become switch params (-DryRun) when true, omitted when false.
    $argList = @()
    if ($cmd.params) {
        foreach ($prop in $cmd.params.PSObject.Properties) {
            $name = $prop.Name
            $val  = $prop.Value
            $pascal = ($name.Substring(0,1).ToUpper() + $name.Substring(1))
            # Convert snake_case to PascalCase for PowerShell param convention.
            if ($pascal -match '_') {
                $parts = $pascal -split '_'
                $pascal = ($parts | ForEach-Object { $_.Substring(0,1).ToUpper() + $_.Substring(1) }) -join ''
            }
            if ($val -is [bool]) {
                if ($val) { $argList += "-$pascal" }
            } else {
                $argList += "-$pascal"
                $argList += "$val"
            }
        }
    }
    $argList += '-JsonOutput'

    # Execute the action script in a child PowerShell so a $ErrorActionPreference
    # blowup in the action doesn't kill the worker. Capture stdout for the
    # JSON payload + treat any 'PCDOCTOR_ERROR:...' line as a structured error.
    $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath @argList 2>&1
    $joined = ($output | Out-String).Trim()
    if ($joined.StartsWith('PCDOCTOR_ERROR:')) {
        $errJson = $joined.Substring('PCDOCTOR_ERROR:'.Length)
        $errObj = $errJson | ConvertFrom-Json -ErrorAction SilentlyContinue
        $msg = if ($errObj -and $errObj.message) { $errObj.message } else { 'Action script reported PCDOCTOR_ERROR' }
        $code = if ($errObj -and $errObj.code) { $errObj.code } else { 'E_ACTION_FAILED' }
        $ex = [System.Exception]::new($msg)
        $ex.Data['code'] = $code
        throw $ex
    }
    # Action succeeded; parse JSON if present, otherwise return raw output.
    $parsed = $null
    try { $parsed = $joined | ConvertFrom-Json -ErrorAction Stop } catch { $parsed = @{ raw = $joined } }
    return $parsed
}

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------
$lastActivity = [DateTime]::UtcNow

while ($true) {
    Update-Heartbeat

    $cmdFiles = @()
    try {
        $cmdFiles = @(Get-ChildItem -Path $QueueDir -Filter '*.cmd.json' -File -ErrorAction Stop)
    } catch {
        # Queue dir disappeared mid-loop (rare; AV cleanup, user manual delete).
        # Recreate and continue.
        if (-not (Test-Path $QueueDir)) {
            try { New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null } catch {}
        }
    }

    foreach ($cmdFile in $cmdFiles) {
        $resultFile = $cmdFile.FullName -replace '\.cmd\.json$', '.result.json'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        $cmd = $null
        try {
            $raw = Get-Content -Path $cmdFile.FullName -Raw -ErrorAction Stop
            $cmd = $raw | ConvertFrom-Json -ErrorAction Stop
        } catch {
            # Malformed cmd file. Write a parse-error result so the caller
            # times out cleanly, and remove the cmd file.
            $errPayload = @{
                id          = $cmdFile.BaseName -replace '\.cmd$', ''
                success     = $false
                error       = @{ code = 'E_BAD_CMD'; message = "Could not parse cmd file: $($_.Exception.Message)" }
                duration_ms = $sw.ElapsedMilliseconds
            }
            try { ($errPayload | ConvertTo-Json -Depth 5 -Compress) | Set-Content -Path $resultFile -Encoding UTF8 } catch {}
            try { Remove-Item -Path $cmdFile.FullName -Force -ErrorAction Stop } catch {}
            continue
        }

        $resultPayload = $null
        try {
            $data = Invoke-CmdAction -cmd $cmd
            $sw.Stop()
            $resultPayload = @{
                id          = "$($cmd.id)"
                success     = $true
                data        = $data
                duration_ms = $sw.ElapsedMilliseconds
            }
        } catch {
            $sw.Stop()
            $code = 'E_ACTION_FAILED'
            if ($_.Exception.Data -and $_.Exception.Data['code']) { $code = "$($_.Exception.Data['code'])" }
            $resultPayload = @{
                id          = "$($cmd.id)"
                success     = $false
                error       = @{ code = $code; message = "$($_.Exception.Message)" }
                duration_ms = $sw.ElapsedMilliseconds
            }
        }

        try {
            ($resultPayload | ConvertTo-Json -Depth 8 -Compress) | Set-Content -Path $resultFile -Encoding UTF8 -ErrorAction Stop
        } catch {
            # If we can't write the result the caller will time out; not
            # ideal but recoverable on the next attempt.
        }
        try { Remove-Item -Path $cmdFile.FullName -Force -ErrorAction Stop } catch {}

        $lastActivity = [DateTime]::UtcNow
    }

    if (([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) {
        # Clean up heartbeat so the unelevated parent stops thinking we're alive.
        try { Remove-Item -Path $heartbeatFile -Force -ErrorAction SilentlyContinue } catch {}
        break
    }

    Start-Sleep -Milliseconds $PollIntervalMs
}

exit 0
