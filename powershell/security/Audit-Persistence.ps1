param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$items = @()

# Startup Run-keys
$runKeys = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Run'
)
foreach ($k in $runKeys) {
    if (-not (Test-Path $k)) { continue }
    $props = (Get-Item $k -ErrorAction SilentlyContinue).Property
    foreach ($name in $props) {
        try {
            $value = (Get-ItemProperty -Path $k -Name $name -ErrorAction Stop).$name
            $items += @{
                kind = 'startup'
                identifier = "startup|$k|$name"
                name = $name
                path = "$value"
            }
        } catch {}
    }
}

# Scheduled tasks
try {
    $output = & schtasks.exe /Query /FO CSV /V 2>$null | ConvertFrom-Csv
    foreach ($t in $output) {
        if (-not $t.'Task To Run') { continue }
        if ($t.TaskName -like '\Microsoft\*') { continue }  # skip Microsoft-managed tasks
        $items += @{
            kind = 'scheduled_task'
            identifier = "task|$($t.TaskName)"
            name = "$($t.TaskName)"
            path = "$($t.'Task To Run')"
            publisher = "$($t.Author)"
        }
    }
} catch {}

# Services (non-Microsoft)
try {
    $services = Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object {
        $_.PathName -and $_.PathName -notmatch '\\system32\\' -and $_.PathName -notmatch '\\SysWOW64\\'
    }
    foreach ($s in $services) {
        $items += @{
            kind = 'service'
            identifier = "service|$($s.Name)"
            name = "$($s.Name)"
            path = "$($s.PathName)"
            publisher = "$($s.StartName)"
        }
    }
} catch {}

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    items = $items
    count = $items.Count
    message = "Enumerated $($items.Count) persistence items"
}
$result | ConvertTo-Json -Depth 5 -Compress
exit 0
