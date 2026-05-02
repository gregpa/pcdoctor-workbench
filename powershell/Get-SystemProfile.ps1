<#
.SYNOPSIS
    Collects system hardware profile for the first-run wizard.

.DESCRIPTION
    Queries CIM/WMI for CPU, RAM, GPU, OS, machine info, logical drives,
    and checks for WSL, Claude CLI, and Obsidian installations. Each
    section is individually wrapped in try/catch so a partial failure
    returns null for that section without crashing the whole script.

.PARAMETER JsonOutput
    Emit compressed JSON (the only supported output format; param kept for
    API parity with other scripts).

.NOTES
    This script does not require admin. Read-only CIM queries only.
#>
param([switch]$JsonOutput)

$ErrorActionPreference = 'Continue'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

# ── CPU ──────────────────────────────────────────────────────────────────
$cpu = $null
try {
    $proc = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($proc) {
        $cpu = [ordered]@{
            name               = $proc.Name.Trim()
            cores              = [int]$proc.NumberOfCores
            logical_processors = [int]$proc.NumberOfLogicalProcessors
            max_clock_mhz      = [int]$proc.MaxClockSpeed
        }
    }
} catch { $cpu = $null }

# ── RAM ──────────────────────────────────────────────────────────────────
$ram = $null
try {
    $cs = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    $dimms = @(Get-CimInstance Win32_PhysicalMemory -ErrorAction SilentlyContinue)
    if ($cs) {
        $totalBytes = [int64]$cs.TotalPhysicalMemory
        $speedMhz   = if ($dimms.Count -gt 0) { [int]($dimms[0].Speed) } else { $null }
        $ram = [ordered]@{
            total_bytes = $totalBytes
            total_gb    = [math]::Round($totalBytes / 1073741824, 0)
            dimm_count  = $dimms.Count
            speed_mhz   = $speedMhz
        }
    }
} catch { $ram = $null }

# ── GPU ──────────────────────────────────────────────────────────────────
$gpu = $null
try {
    $gpus = @(Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch 'Microsoft Basic Display' })
    if ($gpus.Count -gt 0) {
        $g = $gpus[0]
        $gpu = [ordered]@{
            name       = $g.Name
            vram_bytes = if ($g.AdapterRAM) { [int64]$g.AdapterRAM } else { $null }
        }
    }
} catch { $gpu = $null }

# ── OS ───────────────────────────────────────────────────────────────────
$os = $null
try {
    $osi = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if ($osi) {
        $os = [ordered]@{
            caption = $osi.Caption
            version = $osi.Version
            build   = $osi.BuildNumber
            arch    = $osi.OSArchitecture
        }
    }
} catch { $os = $null }

# ── Machine ──────────────────────────────────────────────────────────────
$machine = $null
try {
    $cs2 = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
    if ($cs2) {
        $machine = [ordered]@{
            manufacturer = $cs2.Manufacturer
            model        = $cs2.Model
        }
    }
} catch { $machine = $null }

# ── Drives ───────────────────────────────────────────────────────────────
$drives = @()
try {
    $allDisks = @(Get-CimInstance Win32_LogicalDisk -ErrorAction SilentlyContinue |
        Where-Object { $_.DriveType -in 2, 3, 4 })
    foreach ($d in $allDisks) {
        $drives += [ordered]@{
            letter     = $d.DeviceID
            type       = [int]$d.DriveType
            size_bytes = if ($d.Size)      { [int64]$d.Size }      else { $null }
            free_bytes = if ($d.FreeSpace) { [int64]$d.FreeSpace } else { $null }
            filesystem = $d.FileSystem
            label      = if ($d.VolumeName) { $d.VolumeName } else { $null }
        }
    }
} catch { $drives = @() }

# ── WSL ──────────────────────────────────────────────────────────────────
$wsl = $null
try {
    $wslCmd = Get-Command wsl -ErrorAction SilentlyContinue
    $wslInstalled = $null -ne $wslCmd
    $wslconfigExists = $false
    $memoryLimitGb = $null
    $wslconfigPath = Join-Path $env:USERPROFILE '.wslconfig'
    if (Test-Path $wslconfigPath -ErrorAction SilentlyContinue) {
        $wslconfigExists = $true
        $content = Get-Content $wslconfigPath -ErrorAction SilentlyContinue
        foreach ($line in $content) {
            if ($line -match '^\s*memory\s*=\s*(\d+)\s*(GB|G)\s*$') {
                $memoryLimitGb = [int]$Matches[1]
                break
            }
        }
    }
    $wsl = [ordered]@{
        installed       = $wslInstalled
        wslconfig_exists = $wslconfigExists
        memory_limit_gb  = $memoryLimitGb
    }
} catch { $wsl = $null }

# ── Claude CLI ───────────────────────────────────────────────────────────
$claudeCli = $null
try {
    $claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
    $claudeCli = [ordered]@{
        installed = $null -ne $claudeCmd
        path      = if ($claudeCmd) { $claudeCmd.Source } else { $null }
    }
} catch { $claudeCli = $null }

# ── Obsidian ─────────────────────────────────────────────────────────────
$obsidian = $null
try {
    $obsCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Obsidian\Obsidian.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Obsidian\Obsidian.exe')
    )
    $obsPath = $null
    foreach ($candidate in $obsCandidates) {
        if (Test-Path $candidate -ErrorAction SilentlyContinue) {
            $obsPath = $candidate
            break
        }
    }
    $obsidian = [ordered]@{
        installed = $null -ne $obsPath
        path      = $obsPath
    }
} catch { $obsidian = $null }

# ── Assemble payload ────────────────────────────────────────────────────
$sw.Stop()

$payload = [ordered]@{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    cpu         = $cpu
    ram         = $ram
    gpu         = $gpu
    os          = $os
    machine     = $machine
    drives      = $drives
    wsl         = $wsl
    claude_cli  = $claudeCli
    obsidian    = $obsidian
}

if ($JsonOutput) {
    $payload | ConvertTo-Json -Depth 5 -Compress
} else {
    $payload | ConvertTo-Json -Depth 5
}
exit 0
