<#
.SYNOPSIS
    Enable LibreHardwareMonitor's Remote Web Server (port 8085) automatically.

.DESCRIPTION
    Locates LHM's config XML (sits next to the .exe), terminates LHM if it's
    running (any in-flight LHM process would clobber our edit on its next
    save), flips runWebServerMenuItem to True, persists the file, relaunches
    LHM, and probes http://localhost:8085 to confirm the endpoint is live.

    Greg used to have to do this manually: open LHM tray icon → Options →
    Remote Web Server → Run. v2.5.38 collapses that into a single dashboard
    button.

    Returns a JSON envelope:
      success            bool, true = remote server reachable on port 8085
      exe_path           full path to LibreHardwareMonitor.exe
      config_path        full path to LibreHardwareMonitor.config
      was_running        bool, was LHM running at script start
      was_already_enabled bool, was runWebServerMenuItem already True before our edit
      port               always 8085 (default)
      http_check         'reachable' | 'unreachable' | 'skipped'
      error              optional structured error block

.PARAMETER ExePath
    Full path to LibreHardwareMonitor.exe. Resolved by the caller (Electron
    side) since path discovery is shared with the existing api:openLhm code.

.PARAMETER Port
    Port to use. Defaults to 8085 (LHM's default).

.PARAMETER JsonOutput
    Emit JSON to stdout. Otherwise emit a PSCustomObject for interactive use.

.NOTES
    PowerShell 5.1 compatible. Uses Stop-Process / Start-Process (no admin
    needed -- LHM runs unelevated). The XML manipulation uses
    [xml]::SelectSingleNode + .InnerText so the file's existing whitespace
    and comments survive.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$ExePath,

    [int]$Port = 8085,

    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'

trap {
    $errRecord = @{
        code    = if ($_.FullyQualifiedErrorId) { $_.FullyQualifiedErrorId } else { 'E_PS_UNHANDLED' }
        message = $_.Exception.Message
        script  = $MyInvocation.MyCommand.Name
        line    = $_.InvocationInfo.ScriptLineNumber
    } | ConvertTo-Json -Depth 5 -Compress
    Write-Host "PCDOCTOR_ERROR:$errRecord"
    exit 1
}

if (-not (Test-Path -LiteralPath $ExePath)) {
    $payload = @{ code='E_LHM_EXE_NOT_FOUND'; message="LHM exe not found at $ExePath" } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$payload"
    exit 1
}

$configPath = Join-Path (Split-Path -Parent $ExePath) 'LibreHardwareMonitor.config'

# 1. Stop running LHM. Edits to the config while LHM is alive get clobbered
#    on its next exit (it serializes its in-memory state back).
$wasRunning = $false
$running = Get-Process -Name 'LibreHardwareMonitor' -ErrorAction SilentlyContinue
if ($running) {
    $wasRunning = $true
    foreach ($p in @($running)) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction Stop } catch { }
    }
    # Give Windows a moment to release the file handle.
    Start-Sleep -Milliseconds 600
}

# 2. Read or create the config XML.
[xml]$xml = $null
$wasAlreadyEnabled = $false
if (Test-Path -LiteralPath $configPath) {
    try {
        $xml = New-Object System.Xml.XmlDocument
        $xml.Load($configPath)
    } catch {
        # Malformed config -- back it up and start fresh.
        $bak = "$configPath.bak.$([DateTimeOffset]::UtcNow.ToUnixTimeSeconds())"
        Copy-Item -LiteralPath $configPath -Destination $bak -Force -ErrorAction SilentlyContinue
        $xml = $null
    }
}
if (-not $xml) {
    $xml = New-Object System.Xml.XmlDocument
    $decl = $xml.CreateXmlDeclaration('1.0', 'utf-8', $null)
    $xml.AppendChild($decl) | Out-Null
    $cfg = $xml.CreateElement('configuration')
    $xml.AppendChild($cfg) | Out-Null
    $appSettings = $xml.CreateElement('appSettings')
    $cfg.AppendChild($appSettings) | Out-Null
}

# 3. Find or create <appSettings> and the relevant <add> entries.
$appSettings = $xml.SelectSingleNode('/configuration/appSettings')
if (-not $appSettings) {
    $cfg = $xml.SelectSingleNode('/configuration')
    if (-not $cfg) {
        $cfg = $xml.CreateElement('configuration')
        $xml.AppendChild($cfg) | Out-Null
    }
    $appSettings = $xml.CreateElement('appSettings')
    $cfg.AppendChild($appSettings) | Out-Null
}

function Set-AppSetting {
    param([string]$Key, [string]$Value)
    $node = $appSettings.SelectSingleNode("add[@key='$Key']")
    if ($node) {
        if ($node.GetAttribute('value') -eq $Value) {
            return $true  # already set
        }
        $node.SetAttribute('value', $Value)
        return $false
    }
    $node = $xml.CreateElement('add')
    $node.SetAttribute('key', $Key)
    $node.SetAttribute('value', $Value)
    $appSettings.AppendChild($node) | Out-Null
    return $false
}

$wasAlreadyEnabled = (Set-AppSetting -Key 'runWebServerMenuItem' -Value 'true')
[void](Set-AppSetting -Key 'listenerPort' -Value "$Port")

# 4. Save (atomic-ish: write to temp, move).
$tmp = "$configPath.tmp"
$xml.Save($tmp)
Move-Item -LiteralPath $tmp -Destination $configPath -Force

# 5. Relaunch LHM. The user keeps it tray-minimized (Greg's preference),
#    so this is non-interactive.
Start-Process -FilePath $ExePath -ErrorAction SilentlyContinue | Out-Null

# 6. Wait for the web server to come up. LHM takes ~3-5 seconds to boot
#    its listener on a typical desktop. Poll for up to 12 seconds.
$httpCheck = 'unreachable'
$deadline = (Get-Date).AddSeconds(12)
while ((Get-Date) -lt $deadline) {
    try {
        $r = Invoke-WebRequest -Uri "http://localhost:$Port/" -TimeoutSec 1 -UseBasicParsing -ErrorAction Stop
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
            $httpCheck = 'reachable'
            break
        }
    } catch { }
    Start-Sleep -Milliseconds 500
}

$result = [ordered]@{
    success             = ($httpCheck -eq 'reachable')
    exe_path            = $ExePath
    config_path         = $configPath
    was_running         = $wasRunning
    was_already_enabled = $wasAlreadyEnabled
    port                = $Port
    http_check          = $httpCheck
}

if ($JsonOutput) {
    $result | ConvertTo-Json -Compress
} else {
    [pscustomobject]$result
}
