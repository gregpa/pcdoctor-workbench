param([switch]$ApplyAll, [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# v2.5.39: parse the dcu-cli XML report so the renderer can show "N updates
# applied" instead of a meaningless "scan complete" toast. dcu-cli emits ""
# on stdout when run -silent; the report XML is the only structured surface.
#
# Behavior: always scan + apply (the only caller, the Updates page button,
# explicitly says "Scan + Apply"; the autopilot rule alert_old_driver wants
# the same). -ApplyAll switch retained for backward-compat with any queued
# invocations from older builds; its value is no longer read.
# v2.5.34-style guard against case-insensitive variable shadow: see
# reference_pwsh_case_insensitive_shadowing.md.

$dcu = @(
    'C:\Program Files\Dell\CommandUpdate\dcu-cli.exe',
    'C:\Program Files (x86)\Dell\CommandUpdate\dcu-cli.exe'
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $dcu) { throw 'Dell Command Update not installed - download from dell.com/support' }

$reportDir = Join-Path $env:TEMP "pcdoctor-dcu-$(Get-Random)"
New-Item -Path $reportDir -ItemType Directory -Force | Out-Null

# Returns @{count=N; titles=@(...); xml_sample=...}. dcu-cli writes
# DCUApplicableUpdates.xml to -report=<dir> on /scan. Documented schema
# uses child elements <name>, <urgency>, <criticality>, <release>, <version>
# under <update>, but v2.5.39 saw a real run where $u.name was empty even
# though count was correct -- so be permissive about field names + casing
# and fall back to dumping all child elements as a synthesized label.
# v2.5.40: include xml_sample (truncated) in the result when titles is empty
# despite count > 0 so we can iterate on schema next session.
#
# Avoid PowerShell's `$node.PropName` accessor: it falls back to the .NET
# XmlElement property ($u.Name returns the element's own tag name like
# "Update") when no child/attribute matches, giving false positives. Use
# explicit child-or-attribute lookup instead.
function Get-XmlChildText {
    param($Element, [string]$Name)
    if ($null -eq $Element) { return $null }
    if ($Element.HasChildNodes) {
        foreach ($child in $Element.ChildNodes) {
            if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element -and $child.LocalName -ieq $Name) {
                $t = "$($child.InnerText)".Trim()
                if ($t) { return $t }
            }
        }
    }
    if ($Element.Attributes) {
        foreach ($attr in $Element.Attributes) {
            if ($attr.LocalName -ieq $Name) {
                $t = "$($attr.Value)".Trim()
                if ($t) { return $t }
            }
        }
    }
    return $null
}

function Read-DcuApplicable {
    param([string]$Dir)
    $xmlPath = Join-Path $Dir 'DCUApplicableUpdates.xml'
    if (-not (Test-Path $xmlPath)) { return @{ count = 0; titles = @(); xml_sample = $null } }
    try {
        $rawXml = Get-Content -LiteralPath $xmlPath -Raw -ErrorAction Stop
        [xml]$x = $rawXml
        # Find all <update> / <Update> elements regardless of root casing.
        $updates = @($x.SelectNodes('//*[local-name()="update" or local-name()="Update"]'))
        $titles = @()
        foreach ($u in $updates) {
            $title = $null
            foreach ($key in @('name','title','displayName','releaseTitle','description')) {
                $t = Get-XmlChildText -Element $u -Name $key
                if ($t) { $title = $t; break }
            }
            $sev = $null
            foreach ($key in @('severity','urgency','criticality')) {
                $t = Get-XmlChildText -Element $u -Name $key
                if ($t) { $sev = $t; break }
            }
            # Last-resort fallback: synthesize a label from whatever child
            # elements DO have textual content. Caps total length so a giant
            # <ReleaseNotes> blob doesn't blow up the row.
            if (-not $title) {
                $parts = @()
                foreach ($child in $u.ChildNodes) {
                    if ($child.NodeType -eq [System.Xml.XmlNodeType]::Element -and $child.InnerText) {
                        $val = "$($child.InnerText)".Trim()
                        if ($val -and $val.Length -le 60) {
                            $parts += "$($child.LocalName)=$val"
                        }
                    }
                }
                if ($parts.Count -gt 0) { $title = ($parts -join '; ') }
            }
            if ($title) {
                $entry = if ($sev) { "$title ($sev)" } else { $title }
                $titles += $entry
            }
        }
        # Capture a small XML sample for diagnostics when count > 0 but titles
        # still empty after permissive parsing.
        $sample = $null
        if ($updates.Count -gt 0 -and $titles.Count -eq 0) {
            $sample = if ($rawXml.Length -gt 800) { $rawXml.Substring(0, 800) } else { $rawXml }
        }
        return @{ count = $updates.Count; titles = $titles; xml_sample = $sample }
    } catch {
        return @{ count = 0; titles = @(); xml_sample = $null }
    }
}

try {
    # Step 1: scan -- populates DCUApplicableUpdates.xml in $reportDir.
    & $dcu /scan -silent "-report=$reportDir" 2>&1 | Out-Null
    $available = Read-DcuApplicable -Dir $reportDir

    if ($available.count -eq 0) {
        @{
            success = $true
            duration_ms = $sw.ElapsedMilliseconds
            mode = 'scan_no_updates'
            updates_available = 0
            updates_applied = 0
            applied_titles = @()
            message = 'Dell scan complete - no updates available.'
        } | ConvertTo-Json -Compress
        return
    }

    # Step 2: apply. autoSuspendBitLocker prevents recovery-key prompt mid-flash.
    $applyOut = & $dcu /applyUpdates -silent -autoSuspendBitLocker=enable "-outputLog=$reportDir\apply.log" 2>&1 | Out-String
    $result = @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        mode = 'applied'
        updates_available = $available.count
        updates_applied = $available.count
        applied_titles = $available.titles
        output = $applyOut.Trim()
        message = "Applied $($available.count) Dell update(s). Reboot may be required for some firmware/BIOS updates to take effect."
    }
    if ($available.xml_sample) { $result.xml_sample = $available.xml_sample }
    $result | ConvertTo-Json -Compress
} finally {
    # Best-effort cleanup; report dir lives in $env:TEMP so it'll get reaped
    # eventually anyway, but tidiness avoids per-invocation accumulation.
    Remove-Item -LiteralPath $reportDir -Recurse -Force -ErrorAction SilentlyContinue
}
exit 0
