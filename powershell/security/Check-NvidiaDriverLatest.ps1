param([switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# v2.5.39: rewrite. Old code regex-scraped nvidia.com/en-us/geforce/drivers/
# but that page has been an SPA for a while -- "Game Ready Driver" never
# appears verbatim near the version, so the regex always missed and the
# tile permanently showed "Latest: unknown".
#
# New flow:
#  1. Detect installed marketing version via nvidia-smi (shipped with every
#     consumer driver in System32 since ~2018). If nvidia-smi is missing,
#     derive from Win32_VideoController.DriverVersion last-4 (works for the
#     5xx Marketing-version era; falls back to the raw NMV otherwise).
#  2. Identify the GPU series (Blackwell/Ada/Ampere/Turing/Pascal) from
#     the GPU name and map to a representative PSID/PFID.
#  3. Query the AjaxDriverService.php endpoint -- undocumented but stable
#     since ~2014. Returns DCH WHQL Game Ready info as JSON. We pick a
#     single PSID/PFID per series because Nvidia ships one Game Ready
#     driver per branch (50/40/30 share one line; 20/16 share another;
#     10 yet another), so any in-series lookup yields the same answer.
#  4. Workstation/Pro GPUs (RTX A-series, Quadro, Tesla) fall through to
#     "unknown" with an explanatory message rather than guessing wrong.

# --- Step 1: identify GPU + installed version ----------------------------------
$gpu = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -match 'NVIDIA|GeForce|RTX|GTX' } | Select-Object -First 1
if (-not $gpu) {
    @{
        success = $false
        duration_ms = $sw.ElapsedMilliseconds
        installed_version = $null
        latest_version = $null
        feed_available = $false
        message = 'No Nvidia GPU detected on this system'
    } | ConvertTo-Json -Compress
    exit 0
}

$gpuName = $gpu.Name
$rawDriver = "$($gpu.DriverVersion)"

# Marketing version via nvidia-smi (cleanest source).
$installedVersion = $null
$smi = "$env:WINDIR\System32\nvidia-smi.exe"
if (Test-Path $smi) {
    try {
        $smiOut = & $smi --query-gpu=driver_version --format=csv,noheader,nounits 2>$null | Select-Object -First 1
        if ($smiOut) { $installedVersion = $smiOut.Trim() }
    } catch {}
}

# Fallback: best-effort derive from the Windows driver model number. For the
# 5xx-series drivers, NMV = "32.0.15.WWWW" where WWWW maps to "5XX.YY".
# e.g. "32.0.15.9621" -> "596.21". When Nvidia bumps to 6xx the NMV major
# will likely change; we only attempt the 5xx mapping here and otherwise
# pass through the raw value.
if (-not $installedVersion -and $rawDriver -match '^32\.0\.\d+\.(\d{4})$') {
    $tail = $Matches[1]
    $installedVersion = "5$($tail.Substring(0,2)).$($tail.Substring(2,2))"
}
if (-not $installedVersion) { $installedVersion = $rawDriver }  # last-ditch: surface raw NMV

# --- Step 2: GPU -> series mapping ---------------------------------------------
# Each series gets one representative (psid,pfid). One Game Ready driver
# per branch means picking any in-series GPU yields the right answer.
# Verified live 2026-05-07 on Greg's RTX 3080 (Ampere -> 596.36).
$psid = $null
$pfid = $null
$seriesLabel = $null

if ($gpuName -match 'RTX\s*50\d{2}') {
    $seriesLabel = 'GeForce RTX 50'; $psid = 140; $pfid = 1019
} elseif ($gpuName -match 'RTX\s*40\d{2}') {
    $seriesLabel = 'GeForce RTX 40'; $psid = 132; $pfid = 995
} elseif ($gpuName -match 'RTX\s*30\d{2}') {
    $seriesLabel = 'GeForce RTX 30'; $psid = 127; $pfid = 877
} elseif ($gpuName -match 'RTX\s*20\d{2}|TITAN\s*RTX') {
    $seriesLabel = 'GeForce RTX 20'; $psid = 109; $pfid = 843
} elseif ($gpuName -match 'GTX\s*16\d{2}') {
    $seriesLabel = 'GeForce GTX 16'; $psid = 110; $pfid = 874
} elseif ($gpuName -match 'GTX\s*10\d{2}|TITAN\s*X[pP]?') {
    $seriesLabel = 'GeForce GTX 10'; $psid = 101; $pfid = 771
} elseif ($gpuName -match 'RTX\s*A\d{4}|Quadro|Tesla|NVS') {
    # Workstation/datacenter cards use Studio/Production driver branches with
    # different release cadence; we don't try to look up their latest here.
    @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        installed_version = $installedVersion
        latest_version = $null
        feed_available = $false
        gpu_name = $gpuName
        gpu_series = 'Workstation'
        message = "Installed: $installedVersion. Workstation/Pro GPU detected ($gpuName) -- check Studio/Production driver branch on nvidia.com manually."
    } | ConvertTo-Json -Compress
    exit 0
}

if (-not $psid) {
    # Unknown series (older 9xx Maxwell, exotic SKUs, mobile-only models).
    @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        installed_version = $installedVersion
        latest_version = $null
        feed_available = $false
        gpu_name = $gpuName
        gpu_series = 'Unknown'
        message = "Installed: $installedVersion. GPU series not in lookup map ($gpuName) -- check nvidia.com manually."
    } | ConvertTo-Json -Compress
    exit 0
}

# --- Step 3: query AjaxDriverService.php ---------------------------------------
# osID=135 is Windows 11 64-bit; dch=1 forces the modern DCH driver package.
$latestVersion = $null
$releaseDate = $null
$downloadUrl = $null
$detailsUrl = $null
$feedOk = $false
try {
    $url = 'https://gfwsl.geforce.com/services_toolkit/services/com/nvidia/services/AjaxDriverService.php' +
           "?func=DriverManualLookup&psid=$psid&pfid=$pfid&osID=135&languageCode=1033&isWHQL=1&beta=0&dch=1&dltype=-1&sort1=0&numberOfResults=1"
    $resp = Invoke-RestMethod -Uri $url -TimeoutSec 12 -ErrorAction Stop
    if ($resp.IDS -and $resp.IDS[0].downloadInfo) {
        $info = $resp.IDS[0].downloadInfo
        $latestVersion = "$($info.Version)"
        $releaseDate = "$($info.ReleaseDateTime)"
        $downloadUrl = "$($info.DownloadURL)"
        if ($info.DetailsURL) { $detailsUrl = [System.Uri]::UnescapeDataString("$($info.DetailsURL)") }
        if ($latestVersion) { $feedOk = $true }
    }
} catch {
    # Network failure, cert error, endpoint changed -- swallow; fall through
    # to "unknown" with the installed version still populated for diagnostics.
}

# --- Step 4: format response ---------------------------------------------------
$isOutdated = $false
if ($feedOk -and $installedVersion -and $latestVersion) {
    $isOutdated = ($installedVersion -ne $latestVersion)
}

$message = if (-not $feedOk) {
    "Installed: $installedVersion. Could not reach Nvidia driver feed ($seriesLabel); check manually."
} elseif ($isOutdated) {
    "New driver available: $installedVersion -> $latestVersion (released $releaseDate)"
} else {
    "Up to date: $installedVersion (latest released $releaseDate)"
}

@{
    success = $feedOk
    duration_ms = $sw.ElapsedMilliseconds
    installed_version = $installedVersion
    latest_version = $latestVersion
    feed_available = $feedOk
    is_outdated = $isOutdated
    gpu_name = $gpuName
    gpu_series = $seriesLabel
    release_date = $releaseDate
    download_url = $downloadUrl
    details_url = $detailsUrl
    message = $message
} | ConvertTo-Json -Compress
exit 0
