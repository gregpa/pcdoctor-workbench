<#
.SYNOPSIS
    Pre-ship test harness: validates PendingFileRenameOperations regex patterns.

.DESCRIPTION
    Asserts that:
      1. Every "must match" registry input string is matched by BOTH the
         scanner ($pfroBenignPatterns in Invoke-PCDoctor.ps1) AND the scrub
         ($benignPatterns in Clear-StalePendingRenames.ps1) pattern lists.
      2. Every "must NOT match" decoy string is rejected by both lists.

    Background / root cause (v2.4.34-36):
      $pfroBenignPatterns in Invoke-PCDoctor.ps1 uses quadruple-backslash
      (\\\\) in single-quoted PowerShell strings. In .NET regex, a single-
      quoted PS string passes the literal characters to the regex engine:
        '\\\\' -> regex sees \\\\  -> matches TWO consecutive backslashes.
      PendingFileRenameOperations registry values have SINGLE backslashes
      between path components, so the scanner patterns NEVER match and the
      filter never fires. The scrub script (Clear-StalePendingRenames.ps1)
      uses double-backslash ('\\'), which .NET regex interprets as one
      backslash -- correct.

      This harness empirically verifies pattern-vs-input behavior so the
      bug cannot regress silently through another release.

    MANDATORY PRE-SHIP GATE:
      Run this script and test-installer-acl.ps1 before every packaging
      build. Both must exit 0. Add to the pre-ship checklist alongside
      test-installer-acl.ps1.

    USAGE:
        pwsh -File scripts\test-pfro-pattern-match.ps1

    EXIT CODES:
        0 = all assertions passed, safe to ship
        1 = one or more assertions failed, DO NOT SHIP
#>

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Pattern definitions (inlined from source to keep the harness self-contained
# and to verify the EXACT strings that ship, not a copy-edited version).
# ---------------------------------------------------------------------------

# Scanner patterns: from powershell\Invoke-PCDoctor.ps1 $pfroBenignPatterns.
# MUST stay byte-for-byte in sync with the source. If you change one, change
# both -- if they diverge, this harness gives false confidence. v2.4.37 fix:
# single-backslash `\\` throughout (was `\\\\` pre-v2.4.37, which was broken).
$scannerPatterns = @(
    'gamingservicesproxy_e\.dll',
    'gamingservices_e\.dll',
    'InstallerService',
    '\\Google\\Chrome\\Temp(?:\\|$)',
    '\\Microsoft\\Edge\\Temp(?:\\|$)',
    '\\Mozilla Firefox\\updated(?:\\|$)',
    '\\Mozilla Firefox\\[0-9a-f-]+(?:\\|$)',
    '\\Common Files\\microsoft shared\\ClickToRun\\backup(?:\\|$)',
    '\\Common Files\\microsoft shared\\ClickToRun\\Updates(?:\\|$)',
    '\\Microsoft Office\\Updates\\Apply\\FilesInUse(?:\\|$)',
    '\\System32\\spool\\V4Dirs(?:\\|$)',
    # v2.5.11 (B9):
    '\\Windows\\fonts\\OFFSYM[A-Z]*\.TTF(?:\\|$)',
    '\\Windows\\fonts\\flat_officeFontsPreview\.ttf(?:\\|$)',
    '\\Microsoft\\EdgeUpdate\\\d+\.\d+\.\d+\.\d+(?:\\|$)'
)

# Scrub patterns: from powershell\actions\Clear-StalePendingRenames.ps1 $benignPatterns
$scrubPatterns = @(
    '\\Google\\Chrome\\Temp(?:\\|$)',
    '\\Microsoft\\Edge\\Temp(?:\\|$)',
    '\\Mozilla Firefox\\updated(?:\\|$)',
    '\\Mozilla Firefox\\[0-9a-f-]+(?:\\|$)',
    'gamingservicesproxy_e\.dll',
    'gamingservices_e\.dll',
    'InstallerService',
    '\\Common Files\\microsoft shared\\ClickToRun\\backup(?:\\|$)',
    '\\Common Files\\microsoft shared\\ClickToRun\\Updates(?:\\|$)',
    '\\Microsoft Office\\Updates\\Apply\\FilesInUse(?:\\|$)',
    '\\System32\\spool\\V4Dirs(?:\\|$)',
    # v2.5.11 (B9):
    '\\Windows\\fonts\\OFFSYM[A-Z]*\.TTF(?:\\|$)',
    '\\Windows\\fonts\\flat_officeFontsPreview\.ttf(?:\\|$)',
    '\\Microsoft\\EdgeUpdate\\\d+\.\d+\.\d+\.\d+(?:\\|$)'
)

# ---------------------------------------------------------------------------
# Test inputs: realistic strings pulled from real PendingFileRenameOperations
# registry values. Format: \??\<full path> (the kernel prefix used by the
# Session Manager when reading this registry value).
# ---------------------------------------------------------------------------

# "Must match" cases: all of these are known-benign and both pattern lists
# must accept them so the filter fires and no false-positive flag is raised.
$mustMatch = @(
    # ClickToRun backup with subfolder and GUID
    '\??\C:\Program Files\Common Files\microsoft shared\ClickToRun\backup\BEBA5D7D-1D63-414E-965D-C2D0C992B11F\vcruntime140_1.dll',
    # ClickToRun backup bare directory form (no trailing component)
    '\??\C:\Program Files\Common Files\microsoft shared\ClickToRun\backup',
    # ClickToRun Updates subfolder
    '\??\C:\Program Files\Common Files\microsoft shared\ClickToRun\Updates\BEBA5D7D\mso.dll',
    # Office FilesInUse with GUID and TxFO subfolder
    '\??\C:\Program Files\Microsoft Office\Updates\Apply\FilesInUse\BEBA5D7D\TxFO\root',
    # Office FilesInUse bare directory
    '\??\C:\Program Files\Microsoft Office\Updates\Apply\FilesInUse',
    # Print spooler V4Dirs with nested driver GUID
    '\??\C:\Windows\System32\spool\V4Dirs\89F495CD\94766af2.BUD',
    # Print spooler V4Dirs bare directory
    '\??\C:\Windows\System32\spool\V4Dirs',
    # Chrome Temp with old_chrome.exe (the original bug trigger)
    '\??\C:\Users\greg_\AppData\Local\Google\Chrome\Temp\scoped_dir123\old_chrome.exe',
    # Chrome Temp bare directory
    '\??\C:\Users\greg_\AppData\Local\Google\Chrome\Temp',
    # Edge Temp
    '\??\C:\Users\greg_\AppData\Local\Microsoft\Edge\Temp\scoped_dir456\msedge.old',
    # Firefox updated directory
    '\??\C:\Program Files\Mozilla Firefox\updated\core\xul.dll',
    # Gaming Services proxy DLL (path-embedded)
    '\??\C:\Windows\SystemApps\Microsoft.GamingApp_8wekyb3d8bbwe\gamingservicesproxy_e.dll',
    # Gaming Services proxy DLL with .0 / .1 versioned suffix (real form on Greg's box 2026-04-30)
    '\??\C:\Windows\System32\gamingservicesproxy_e.dll.0',
    # Gaming Services DLL (bare filename match)
    'gamingservices_e.dll',
    # InstallerService token
    'C:\Program Files\WindowsApps\Microsoft.GamingServices_InstallerService_stager',
    # v2.5.11 (B9): Office Click-to-Run symbol fonts (all 6 real variants observed 2026-04-30)
    '\??\C:\Windows\Fonts\OFFSYM.TTF',
    '\??\C:\Windows\Fonts\OFFSYMB.TTF',
    '\??\C:\Windows\Fonts\OFFSYML.TTF',
    '\??\C:\Windows\Fonts\OFFSYMSB.TTF',
    '\??\C:\WINDOWS\Fonts\OFFSYMSL.TTF',
    '\??\C:\Windows\Fonts\OFFSYMXL.TTF',
    '\??\C:\Windows\Fonts\flat_officeFontsPreview.ttf',
    # v2.5.11 (B9): Edge updater old-version directory (real entry observed 2026-04-30)
    '\??\C:\Program Files (x86)\Microsoft\EdgeUpdate\1.3.229.3'
)

# "Must NOT match" cases: real-looking paths that should NOT be filtered.
# If a pattern fires on any of these, the filter is too broad.
$mustNotMatch = @(
    # A real Windows Update CBS temp file (not a known-benign pattern)
    '\??\C:\Windows\WinSxS\amd64_microsoft-windows-foo_31bf3856ad364e35\kernel32.dll',
    # A driver install temp that is not the spooler V4Dirs
    '\??\C:\Windows\System32\spool\Drivers\x64\3\prnbr001.inf',
    # A user profile path that happens to contain "Chrome" but not in Temp
    '\??\C:\Users\greg_\AppData\Local\Google\Chrome\User Data\Default\Cache\someblob',
    # Edge install dir, not Temp
    '\??\C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    # A third-party app that resembles Firefox but is not
    '\??\C:\Program Files\Mozilla Firefox Pro\core\xul.dll',
    # An empty string (registry multi-sz often has a trailing empty entry)
    '',
    # A system driver with no relation to any benign pattern
    '\??\C:\Windows\System32\drivers\ntfs.sys',
    # v2.5.11 (B9): a generic system font NOT in the Office symbol family —
    # real font subsystem changes DO need a reboot, must NOT be filtered.
    '\??\C:\Windows\Fonts\arial.ttf',
    # v2.5.11 (B9): the live EdgeUpdate executable (no version subdir) —
    # genuine pending update of the updater itself, must NOT be filtered.
    '\??\C:\Program Files (x86)\Microsoft\EdgeUpdate\MicrosoftEdgeUpdate.exe',
    # v2.5.11 (B9): the live EdgeUpdate config XML — must NOT be filtered.
    '\??\C:\Program Files (x86)\Microsoft\EdgeUpdate\config.xml'
)

# ---------------------------------------------------------------------------
# Test runner
# ---------------------------------------------------------------------------

$failures = 0
$passed   = 0

function Test-Pattern {
    param(
        [string]   $ListName,
        [string[]] $Patterns,
        [string]   $InputStr,
        [bool]     $ShouldMatch
    )

    $matched = $false
    $matchingPat = $null
    foreach ($pat in $Patterns) {
        if ($InputStr -match $pat) {
            $matched = $true
            $matchingPat = $pat
            break
        }
    }

    $ok = ($matched -eq $ShouldMatch)
    if ($ok) {
        $script:passed++
    } else {
        $script:failures++
        $expectVerb = if ($ShouldMatch) { 'MATCH' } else { 'NOT match' }
        $gotVerb    = if ($matched) { 'DID match' } else { 'did NOT match' }
        Write-Host "[FAIL] $ListName : expected $expectVerb, but $gotVerb" -ForegroundColor Red
        Write-Host "       input   : $InputStr" -ForegroundColor Red
        if ($matched) {
            Write-Host "       pattern : $matchingPat" -ForegroundColor Red
        }
        Write-Host ''
    }
}

Write-Host '==================================================================='
Write-Host 'PCDoctor PFRO pattern-match test harness'
Write-Host '==================================================================='
Write-Host ''
Write-Host '--- Must-match cases (benign entries that MUST be filtered) ---'
foreach ($inp in $mustMatch) {
    Test-Pattern -ListName 'scanner' -Patterns $scannerPatterns -InputStr $inp -ShouldMatch $true
    Test-Pattern -ListName 'scrub'   -Patterns $scrubPatterns   -InputStr $inp -ShouldMatch $true
}

Write-Host '--- Must-NOT-match cases (real entries that must NOT be filtered) ---'
foreach ($inp in $mustNotMatch) {
    Test-Pattern -ListName 'scanner' -Patterns $scannerPatterns -InputStr $inp -ShouldMatch $false
    Test-Pattern -ListName 'scrub'   -Patterns $scrubPatterns   -InputStr $inp -ShouldMatch $false
}

Write-Host ''
Write-Host '==================================================================='
if ($failures -gt 0) {
    Write-Host "[RESULT] $failures FAILED, $passed passed. DO NOT SHIP." -ForegroundColor Red
    Write-Host ''
    Write-Host 'DIAGNOSIS: If scanner-list failures all occur on paths with single'
    Write-Host 'backslashes, the root cause is quadruple-backslash escaping in'
    Write-Host '$pfroBenignPatterns (Invoke-PCDoctor.ps1 ~line 384). Change every'
    Write-Host "quadruple-backslash ('\\\\\\\\') to double-backslash ('\\\\') and"
    Write-Host 'every (?:\\\\|$) to (?:\\|$) to match real registry path separators.'
    exit 1
} else {
    Write-Host "[RESULT] All $passed assertions passed. Safe to ship." -ForegroundColor Green
    exit 0
}
