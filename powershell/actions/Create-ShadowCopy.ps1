param([string]$Drive = 'C:', [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$out = & wmic.exe shadowcopy call create Volume="$Drive\" 2>&1 | Out-String
$success = $out -match 'ReturnValue = 0'

$sw.Stop()
@{
    success = $success
    duration_ms = $sw.ElapsedMilliseconds
    drive = $Drive
    output = $out.Trim()
    message = if ($success) { "Shadow copy created for $Drive" } else { "Shadow copy failed — may need admin" }
} | ConvertTo-Json -Compress
exit 0
