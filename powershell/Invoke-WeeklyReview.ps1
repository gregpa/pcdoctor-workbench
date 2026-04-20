<#
.SYNOPSIS
    Generates the weekly review JSON + markdown from latest.json + historical data.
.DESCRIPTION
    Runs every Sunday 10 PM. Produces reports/weekly/YYYY-MM-DD.{json,md} and a
    .pending-review flag. Dashboard surfaces the review Monday morning.
#>
param(
    [switch]$DryRun,
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

if ($DryRun) {
    $result = @{ success = $true; dry_run = $true; duration_ms = $sw.ElapsedMilliseconds; message = 'DryRun' }
    $result | ConvertTo-Json -Depth 3 -Compress
    exit 0
}

$root = 'C:\ProgramData\PCDoctor'
$latestPath = Join-Path $root 'reports\latest.json'
$weeklyDir = Join-Path $root 'reports\weekly'
if (-not (Test-Path $weeklyDir)) { New-Item -ItemType Directory -Path $weeklyDir -Force | Out-Null }

if (-not (Test-Path $latestPath)) {
    throw "latest.json not found at $latestPath. Run Invoke-PCDoctor first."
}

$raw = Get-Content $latestPath -Raw -Encoding UTF8
# Strip BOM if present
if ($raw.Length -gt 0 -and [int][char]$raw[0] -eq 0xFEFF) { $raw = $raw.Substring(1) }
$latest = $raw | ConvertFrom-Json

# Organize findings by severity
$critical = @($latest.findings | Where-Object { $_.severity -eq 'critical' })
$warnings = @($latest.findings | Where-Object { $_.severity -eq 'warning' })
$infos = @($latest.findings | Where-Object { $_.severity -eq 'info' })

$actionMap = @{
    'Memory'   = @{ action_name = 'apply_wsl_cap'; label = 'Apply WSL Memory Cap' }
    'Search'   = @{ action_name = 'rebuild_search_index'; label = 'Rebuild Search Index' }
    'Explorer' = @{ action_name = 'fix_shell_overlays'; label = 'Fix Shell Overlays' }
    'NAS'      = @{ action_name = 'remap_nas'; label = 'Remap NAS Drives' }
    'Startup'  = @{ action_name = 'disable_startup_item'; label = 'Disable Startup Item' }
}

function Make-ActionItem($f, $priority) {
    $action = $null
    if ($actionMap.ContainsKey($f.area)) { $action = $actionMap[$f.area] }
    return @{
        id = [guid]::NewGuid().ToString()
        priority = $priority
        area = $f.area
        message = $f.message
        detail = $f.detail
        suggested_action = $action
    }
}

$items = @()
foreach ($f in $critical) { $items += Make-ActionItem $f 'critical' }
foreach ($f in $warnings) { $items += Make-ActionItem $f 'important' }
foreach ($f in $infos)    { $items += Make-ActionItem $f 'info' }

$headroom = @{
    ram = if ($latest.metrics.ram_used_pct) { "$($latest.metrics.ram_used_pct)% used ($(($latest.metrics.ram_free_gb)) GB free)" } else { "n/a" }
    cpu_load = if ($latest.metrics.cpu_load_pct -ne $null) { "$($latest.metrics.cpu_load_pct)%" } else { "n/a" }
    disk_c_free = if ($latest.metrics.disks) {
        $c = $latest.metrics.disks | Where-Object { $_.drive -eq 'C:' } | Select-Object -First 1
        if ($c) { "$($c.free_pct)% ($(([int]$c.free_gb)) GB free of $(([int]$c.size_gb)) GB)" } else { "n/a" }
    } else { "n/a" }
    event_errors_7d = if ($latest.metrics.event_errors_7d) { "System: $($latest.metrics.event_errors_7d.system_count), App: $($latest.metrics.event_errors_7d.application_count)" } else { "n/a" }
    uptime = if ($latest.metrics.uptime_hours) { "$($latest.metrics.uptime_hours) hours" } else { "n/a" }
}

$reviewDate = Get-Date -Format 'yyyy-MM-dd'
$jsonPath = Join-Path $weeklyDir "$reviewDate.json"
$mdPath = Join-Path $weeklyDir "$reviewDate.md"

$review = @{
    review_date = $reviewDate
    generated_at = [int][double]::Parse((Get-Date -UFormat %s))
    hostname = $latest.hostname
    summary = @{
        overall = $latest.summary.overall
        critical_count = $critical.Count
        warning_count = $warnings.Count
        info_count = $infos.Count
    }
    action_items = $items
    headroom = $headroom
    forecast_digest = @()   # populated by Get-Forecast caller if desired
}

$review | ConvertTo-Json -Depth 10 | Out-File -FilePath $jsonPath -Encoding UTF8 -Force

# Markdown rendering
$md = @"
# PC Doctor Weekly Review - $reviewDate

**Host:** $($latest.hostname)
**Overall:** $($review.summary.overall) - $($review.summary.critical_count) critical, $($review.summary.warning_count) warning, $($review.summary.info_count) info

---

"@

if ($critical.Count -gt 0) {
    $md += "## Critical - Act this week`n`n"
    foreach ($f in $critical) {
        $md += "### $($f.area)`n"
        $md += "$($f.message)`n`n"
        if ($actionMap.ContainsKey($f.area)) {
            $md += "**Recommended action:** $($actionMap[$f.area].label)`n`n"
        }
        $md += "---`n`n"
    }
}

if ($warnings.Count -gt 0) {
    $md += "## Important - Act this month`n`n"
    foreach ($f in $warnings) {
        $md += "### $($f.area)`n"
        $md += "$($f.message)`n`n"
        if ($actionMap.ContainsKey($f.area)) {
            $md += "**Recommended action:** $($actionMap[$f.area].label)`n`n"
        }
        $md += "---`n`n"
    }
}

if ($infos.Count -gt 0) {
    $md += "## Info`n`n"
    foreach ($f in $infos) {
        $md += "- **$($f.area):** $($f.message)`n"
    }
    $md += "`n---`n`n"
}

$md += "## Headroom and Trends`n`n"
$md += "- **RAM:** $($headroom.ram)`n"
$md += "- **CPU load:** $($headroom.cpu_load)`n"
$md += "- **C: drive free:** $($headroom.disk_c_free)`n"
$md += "- **Event errors (7d):** $($headroom.event_errors_7d)`n"
$md += "- **Uptime:** $($headroom.uptime)`n`n"

$md | Out-File -FilePath $mdPath -Encoding UTF8 -Force

# Flag pending review
$flagPath = Join-Path $weeklyDir '.pending-review'
Set-Content -Path $flagPath -Value $reviewDate -Encoding ASCII -Force

# Auto-archive to Obsidian Vault
$obsidianDir = 'C:\Users\greg_\Documents\Claude Cowork\Obsidian Vault\PC Doctor\Weekly Reviews'
try {
    if (-not (Test-Path $obsidianDir)) { New-Item -ItemType Directory -Path $obsidianDir -Force | Out-Null }
    Copy-Item -Path $mdPath -Destination (Join-Path $obsidianDir "$reviewDate.md") -Force
} catch {
    # non-fatal
}

$sw.Stop()

$result = @{
    success = $true
    duration_ms = $sw.ElapsedMilliseconds
    review_date = $reviewDate
    json_path = $jsonPath
    md_path = $mdPath
    flag_path = $flagPath
    action_items = $items.Count
    critical = $critical.Count
    warning = $warnings.Count
    info = $infos.Count
    message = "Weekly review generated: $($items.Count) action items"
}

$result | ConvertTo-Json -Depth 3 -Compress
exit 0
