param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Continue'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }

if ($DryRun) { @{success=$true;dry_run=$true;tasks=@()} | ConvertTo-Json -Compress; exit 0 }

# Use the Task Scheduler COM API directly. Reasons we avoid alternatives:
#  - schtasks.exe from a PowerShell child takes ~6s per call on this box
#    (Defender real-time scan overhead on each spawn). 20 serial calls = 2 min.
#  - Get-ScheduledTask cmdlet fails here: MSFT_ScheduledTask CIM provider
#    reports "The system cannot find the file specified."
#  - schtasks /Query without /TN chokes on a corrupted Microsoft subtask.
# COM Schedule.Service returns all 20 PCDoctor tasks in ~3 seconds.
$ts = New-Object -ComObject Schedule.Service
$ts.Connect()
$folder = $ts.GetFolder('\')

# State codes: 0=Unknown, 1=Disabled, 2=Queued, 3=Ready, 4=Running
$stateMap = @{ 0 = 'Unknown'; 1 = 'Disabled'; 2 = 'Queued'; 3 = 'Ready'; 4 = 'Running' }

# GetTasks(1) includes hidden tasks; we only pick PCDoctor-*.
$results = @()
foreach ($t in ($folder.GetTasks(1) | Where-Object { $_.Name -like 'PCDoctor-*' })) {
    $lastRun = $null
    if ($t.LastRunTime -and $t.LastRunTime.Year -gt 1990) { $lastRun = $t.LastRunTime.ToString('s') }
    $nextRun = $null
    if ($t.NextRunTime -and $t.NextRunTime.Year -gt 1990) { $nextRun = $t.NextRunTime.ToString('s') }
    $results += @{
        name        = $t.Name
        status      = $stateMap[[int]$t.State]
        last_run    = $lastRun
        next_run    = $nextRun
        last_result = "$([int]$t.LastTaskResult)"
    }
}

@{ success = $true; tasks = @($results) } | ConvertTo-Json -Depth 5 -Compress
exit 0
