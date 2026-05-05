<#
.SYNOPSIS
    Enumerates ALL Windows services with status, startup type, dependencies,
    and a load-bearing flag for system-critical services.

.DESCRIPTION
    v2.5.30: powers the new Services page. Distinct from the curated
    ServiceHealth list at src/main/pcdoctorBridge.ts (which surfaces ~10
    services on the Dashboard). This script returns every service the OS
    exposes via Get-CimInstance Win32_Service (~200-300 on a typical box).

    Per-row payload:
      key                  service short name (e.g. 'Spooler')
      display              display name ('Print Spooler')
      status               'Running' | 'Stopped' | 'StartPending' | ...
      start_type           'Automatic' | 'AutomaticDelayedStart' | 'Manual' | 'Disabled' | 'Boot' | 'System'
      binary_path          path to the service binary (truncated args)
      description          MSDN description, often null
      depends_on           array of service keys this depends on
      dependents           array of service keys that depend on this
      load_bearing         true for services where Disable bricks Windows
      load_bearing_reason  short text shown on the safety badge (null when false)

    Driver services (Boot/System start_type) are filtered out -- their
    boot-loop blast radius is too high for a UI action surface and they
    would clutter the table. Users with driver-class needs can still drop
    to sc.exe directly.

.PARAMETER JsonOutput
    Emit compressed JSON. Default true; the param exists for parity with
    other Get-* scripts in this codebase.

.NOTES
    PowerShell 5.1 compatible (no ?? null-coalesce, no ?. null-conditional,
    no ternary). Verified by scripts/test-ps51-syntax.ps1.
#>
param(
    [switch]$JsonOutput
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

# ---------------------------------------------------------------------------
# Load-bearing classification.
# Disabling any of these via services.msc has been observed to brick Windows
# (no boot, no network, no login). Sources: Microsoft "Critical/Essential"
# service tables + community recovery threads. Conservative -- when in doubt
# we mark it load_bearing rather than risk the user disabling something that
# requires Safe Mode + sc.exe to recover.
# ---------------------------------------------------------------------------
$LoadBearingMap = @{
    'RpcSs'    = 'Remote Procedure Call (RPC) — disabling halts virtually every other service.'
    'EventLog' = 'Windows Event Log — disabling breaks logon, services, and Defender.'
    'CryptSvc' = 'Cryptographic Services — disabling breaks Windows Update, signed-binary verification, and Edge.'
    'Dhcp'     = 'DHCP Client — disabling breaks all network connectivity unless every NIC is statically configured.'
    'Dnscache' = 'DNS Client — disabling breaks all DNS-based network operations.'
    'LSM'      = 'Local Session Manager — disabling can prevent logon.'
    'Power'    = 'Power management — disabling can prevent sleep/wake and may halt boot.'
    'ProfSvc'  = 'User Profile Service — disabling prevents user logon.'
    'Schedule' = 'Task Scheduler — disabling breaks Windows Update, scheduled scans, and PCDoctor itself.'
    'SamSs'    = 'Security Accounts Manager — disabling prevents logon.'
    'WinDefend'= 'Microsoft Defender Antivirus — disabling exposes the system to malware unless replaced.'
    'wuauserv' = 'Windows Update — disabling halts security patching.'
    'Winmgmt'  = 'Windows Management Instrumentation (WMI) — disabling breaks many management tools and PCDoctor scans.'
    'gpsvc'    = 'Group Policy Client — disabling can prevent logon on domain-joined machines.'
    'BFE'      = 'Base Filtering Engine — disabling halts the Windows Firewall and IPsec.'
    'MpsSvc'   = 'Windows Defender Firewall — disabling disables host-based packet filtering.'
}

# ---------------------------------------------------------------------------
# Pull services via two sources to assemble a complete picture:
#   1. Get-CimInstance Win32_Service -- gives StartMode, State, PathName,
#      Description, plus DependentServices/ServicesDependedOn lazily.
#   2. Get-Service -- gives DependentServices + ServicesDependedOn already
#      materialized as objects (CIM lazy-loads them per row, expensive).
# ---------------------------------------------------------------------------
$cimRows = Get-CimInstance -ClassName Win32_Service -ErrorAction Stop
$psRows  = Get-Service -ErrorAction Stop
$psByName = @{}
foreach ($s in $psRows) { $psByName[$s.Name] = $s }

# ---------------------------------------------------------------------------
# StartMode normalization.
# Win32_Service.StartMode returns 'Auto' but we surface 'Automatic' for the
# UI (matches services.msc). DelayedAutoStart is a separate column on the
# CIM row; combine into 'AutomaticDelayedStart' if true.
# ---------------------------------------------------------------------------
function Get-StartTypeLabel {
    param($cim)
    $mode = "$($cim.StartMode)"
    switch ($mode) {
        'Auto'     { if ($cim.DelayedAutoStart) { return 'AutomaticDelayedStart' } else { return 'Automatic' } }
        'Manual'   { return 'Manual' }
        'Disabled' { return 'Disabled' }
        'Boot'     { return 'Boot' }
        'System'   { return 'System' }
        default    { return $mode }
    }
}

$out = @()
foreach ($cim in $cimRows) {
    $startType = Get-StartTypeLabel -cim $cim

    # Filter driver services -- out of scope for this UI surface (see plan).
    if ($startType -eq 'Boot' -or $startType -eq 'System') { continue }

    $key = $cim.Name
    $ps  = $psByName[$key]

    # Dependency arrays. Get-Service materializes these as service objects;
    # we just want the keys.
    $dependsOn = @()
    $dependents = @()
    if ($ps) {
        foreach ($d in $ps.ServicesDependedOn) { $dependsOn += $d.Name }
        foreach ($d in $ps.DependentServices)  { $dependents += $d.Name }
    }

    # Truncate binary_path: drop quoted-arg tail past the .exe so the column
    # stays readable. The full PathName remains visible in the row's
    # expanded view. Defensive: PathName can be empty/null on synthesized
    # services (drvinst spawn workers etc.); just emit empty string then.
    $binaryPath = ''
    $rawPath = "$($cim.PathName)"
    if ($rawPath) {
        $m = [regex]::Match($rawPath, '^("[^"]+"|[^\s]+)')
        if ($m.Success) { $binaryPath = $m.Value.Trim('"') } else { $binaryPath = $rawPath }
    }

    $rowLoadBearing = $false
    $rowLoadBearingReason = $null
    if ($LoadBearingMap.ContainsKey($key)) {
        $rowLoadBearing = $true
        $rowLoadBearingReason = $LoadBearingMap[$key]
    }

    $row = @{
        key                 = $key
        display             = "$($cim.DisplayName)"
        status              = "$($cim.State)"
        start_type          = $startType
        binary_path         = $binaryPath
        description         = "$($cim.Description)"
        depends_on          = $dependsOn
        dependents          = $dependents
        load_bearing        = $rowLoadBearing
        load_bearing_reason = $rowLoadBearingReason
    }
    $out += ,$row
}

$sw.Stop()
$payload = @{
    success     = $true
    duration_ms = $sw.ElapsedMilliseconds
    count       = $out.Count
    services    = $out
}
$payload | ConvertTo-Json -Depth 5 -Compress
exit 0
