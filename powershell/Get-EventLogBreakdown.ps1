<#
.SYNOPSIS
    Top-N (provider, event-id) breakdown of System-log errors in the last
    N days. Powers the Event Log detail modal in the Dashboard.
.DESCRIPTION
    v2.4.6: the Event Log Errors chart on the Dashboard surfaces a daily
    count but doesn't tell the user WHICH providers / event IDs are
    driving that count. This script produces the breakdown on demand
    (IPC-invoked, not part of the scheduled scan, since it's only needed
    when the user opens the detail modal).

    Returns a ranked list of up to $TopN entries plus total, so the modal
    can show "X out of Y total errors accounted for by these Z sources".

    Safe to run non-elevated. Get-WinEvent reads the System log without
    admin as long as the user is in the Event Log Readers group (default
    for all local accounts).
.PARAMETER Days
    Lookback window. Default 7.
.PARAMETER TopN
    Max entries to return. Default 10.
.PARAMETER Level
    Win event level. Default 2 (Error). Pass 3 for Warning. Pass 2,3 for
    both (comma-separated).
#>
param(
    [int]$Days = 7,
    [int]$TopN = 10,
    [string]$Level = '2',
    [switch]$JsonOutput
)

$ErrorActionPreference = 'Stop'
trap {
    $e = @{ code='E_PS_UNHANDLED'; message=$_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$e"
    exit 1
}

$sw = [System.Diagnostics.Stopwatch]::StartNew()

$levels = $Level -split ',' | ForEach-Object { [int]$_.Trim() }
$startTime = (Get-Date).AddDays(-$Days)

# Build a filter hashtable. Get-WinEvent with a hash is much faster than
# pulling every event and filtering in PowerShell (the filter is pushed
# down to the Event Log service).
$filter = @{
    LogName = 'System'
    Level = $levels
    StartTime = $startTime
}

$events = @()
try {
    $events = @(Get-WinEvent -FilterHashtable $filter -ErrorAction Stop)
} catch {
    # No events is a valid result (ObjectNotFound); everything else is
    # a real failure we should surface.
    if ($_.Exception.Message -match 'No events were found') {
        $events = @()
    } else { throw }
}

$total = $events.Count
$grouped = $events | Group-Object -Property ProviderName, Id | Sort-Object Count -Descending

$top = @($grouped | Select-Object -First $TopN | ForEach-Object {
    # v2.4.10: pick most-recent occurrence explicitly for last_seen_iso.
    # Prior code used $_.Group[0] which relied on Get-WinEvent's implicit
    # newest-first ordering — worked in practice but not guaranteed by the
    # API, and obviously wrong once we sort the group for any reason.
    # Use .Group[0] still for the representative sample_message (first
    # occurrence, typically the clearest in context), but compute
    # last_seen_iso from the max timestamp.
    $first = $_.Group[0]
    $mostRecent = ($_.Group | Sort-Object TimeCreated -Descending | Select-Object -First 1)
    [ordered]@{
        provider     = "$($first.ProviderName)"
        event_id     = [int]$first.Id
        count        = $_.Count
        # One representative message (the first occurrence). Often enough
        # context to know whether the cluster matters.
        sample_message = if ($first.Message) {
            $msg = "$($first.Message)"
            if ($msg.Length -gt 400) { $msg.Substring(0, 400) + '...' } else { $msg }
        } else { '' }
        # Most recent timestamp — useful for "is this still happening?"
        last_seen_iso = $mostRecent.TimeCreated.ToString('s')
    }
})

$accountedFor = ($top | Measure-Object -Property count -Sum).Sum
if ($null -eq $accountedFor) { $accountedFor = 0 }

$result = [ordered]@{
    success          = $true
    duration_ms      = $sw.ElapsedMilliseconds
    days             = $Days
    total_errors     = $total
    top_n            = $TopN
    returned         = $top.Count
    accounted_for    = $accountedFor
    accounted_pct    = if ($total -gt 0) { [math]::Round(100.0 * $accountedFor / $total, 1) } else { 0 }
    top              = $top
    start_time_iso   = $startTime.ToString('s')
    message          = if ($total -eq 0) {
        "No Error-level events in the last $Days days."
    } else {
        "$total total Error-level events; top $($top.Count) providers account for $accountedFor ($(if ($total -gt 0) { [math]::Round(100.0 * $accountedFor / $total, 1) } else { 0 })%)."
    }
}

if ($JsonOutput) { $result | ConvertTo-Json -Depth 6 -Compress } else { $result | ConvertTo-Json -Depth 6 }
exit 0
