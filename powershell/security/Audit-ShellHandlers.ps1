param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

$root = 'Registry::HKEY_CLASSES_ROOT\*\shellex\ContextMenuHandlers'
$handlers = @()
if (Test-Path $root) {
    $keys = Get-ChildItem -Path $root -ErrorAction SilentlyContinue
    foreach ($k in $keys) {
        try {
            $clsid = (Get-ItemProperty -Path $k.PSPath -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
            if (-not $clsid) { $clsid = $k.PSChildName }
            $clsidKey = "Registry::HKEY_CLASSES_ROOT\CLSID\$clsid\InprocServer32"
            $dll = $null
            if (Test-Path $clsidKey) {
                $dll = (Get-ItemProperty -Path $clsidKey -Name '(default)' -ErrorAction SilentlyContinue).'(default)'
            }
            $signed = $null
            if ($dll -and (Test-Path $dll)) {
                $sig = Get-AuthenticodeSignature $dll -ErrorAction SilentlyContinue
                $signed = $sig -and $sig.Status -eq 'Valid'
            }
            $handlers += @{
                name = $k.PSChildName
                clsid = $clsid
                dll = $dll
                signed = $signed
            }
        } catch {}
    }
}

$unsigned = @($handlers | Where-Object { $_.dll -and $_.signed -eq $false })

$sw.Stop()
@{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    total = $handlers.Count
    unsigned_count = $unsigned.Count
    unsigned = $unsigned
    severity = if ($unsigned.Count -gt 0) { 'warn' } else { 'good' }
    message = "Shell handlers: $($handlers.Count) total, $($unsigned.Count) unsigned"
} | ConvertTo-Json -Depth 4 -Compress
exit 0
