<#
.SYNOPSIS
    Pre-ship gate (#6): verify the bundled better_sqlite3.node was built
    against Electron 33's NODE_MODULE_VERSION (NMV 130), not Node's NMV.

.DESCRIPTION
    v2.4.46 shipped with `better_sqlite3.node` compiled against Node 22's
    NMV 137 because `npm run package` invoked electron-builder without first
    rebuilding native modules against the embedded Electron version. Result:
    every install threw on first DB query with
        "compiled against a different Node.js version using
         NODE_MODULE_VERSION 137. This version of Node.js requires
         NODE_MODULE_VERSION 130."
    The renderer then painted red error bands on every page that read the DB.

    v2.4.47 fix: package.json `package` script now runs
        npx @electron/rebuild -f -o better-sqlite3
    between build and electron-builder. This gate verifies that fix actually
    took effect by attempting to load the .node from a Node.js sub-process
    and parsing the ABI mismatch error message.

    METHOD:
      1. Spawn `node -e "require(<path>)"` against the target .node.
      2. If the load succeeds, the .node was built with whatever NMV Node
         is using (typically 137). For an Electron-targeted .node we EXPECT
         this to FAIL with a parseable error.
      3. If the load fails with "compiled against a different Node.js
         version using NODE_MODULE_VERSION <X>", parse <X>. That's the
         binary's own NMV. PASS if it equals -ExpectedNmv (Electron 33 = 130).
      4. Other failures bubble up as FAIL.

.PARAMETER NodePath
    Optional explicit path to the .node file. Defaults to the unpacked
    location produced by electron-builder:
        release/win-unpacked/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
    If that does not exist, falls back to the dev tree at
        node_modules/better-sqlite3/build/Release/better_sqlite3.node.

.PARAMETER ExpectedNmv
    NMV the .node MUST report. Defaults to 130 (Electron 33).

.EXAMPLE
    powershell.exe -ExecutionPolicy Bypass -File scripts/verify-better-sqlite3-abi.ps1
    powershell.exe -ExecutionPolicy Bypass -File scripts/verify-better-sqlite3-abi.ps1 -NodePath C:\path\to\better_sqlite3.node -ExpectedNmv 130

.EXIT CODES
    0 = bundled .node has the expected NMV, safe to ship
    1 = NMV mismatch OR .node not found OR Node load produced an unexpected error

.NOTES
    Q3 in plan-v2.4.47.md commits to running this gate every release through
    v2.5.1, then re-evaluating. After ANY change to electron-builder.yml,
    package.json scripts, or better-sqlite3 / electron versions, run this
    gate to confirm the rebuild step still hooks in.

    Why probe rather than scan?
    The compiled .node binary does NOT embed the literal string
    "NODE_MODULE_VERSION 130" — the ABI value is encoded as a binary integer
    in the module registration record consumed by Node's loader. The only
    reliable way to read it is to attempt the load. This is also exactly
    what @electron/rebuild itself does to detect mismatches.
#>
param(
    [string]$NodePath = $null,
    [int]$ExpectedNmv = 130
)

$ErrorActionPreference = 'Stop'

function Write-Result {
    param([string]$status, [string]$message, [hashtable]$extra = @{})
    $obj = @{
        gate    = 'verify-better-sqlite3-abi'
        status  = $status
        message = $message
    }
    foreach ($k in $extra.Keys) { $obj[$k] = $extra[$k] }
    $json = $obj | ConvertTo-Json -Compress -Depth 4
    Write-Output $json
}

# Resolve target .node path
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $NodePath) {
    $packaged = Join-Path $repoRoot 'release\win-unpacked\resources\app.asar.unpacked\node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    $dev      = Join-Path $repoRoot 'node_modules\better-sqlite3\build\Release\better_sqlite3.node'
    if (Test-Path $packaged) {
        $NodePath = $packaged
        Write-Host "[verify-abi] Inspecting packaged .node: $packaged"
    } elseif (Test-Path $dev) {
        $NodePath = $dev
        Write-Host "[verify-abi] Inspecting dev .node:      $dev"
        Write-Host "[verify-abi] (no win-unpacked tree found; package first to gate the actual installer payload.)"
    } else {
        Write-Result -status 'FAIL' -message 'better_sqlite3.node not found in win-unpacked OR node_modules.'
        exit 1
    }
}

if (-not (Test-Path $NodePath)) {
    Write-Result -status 'FAIL' -message "NodePath does not exist: $NodePath"
    exit 1
}

# Get Node's own NMV. This is what the binary will report it was loaded by.
$runtimeNmv = [int](& node -e "process.stdout.write(String(process.versions.modules))" 2>&1)

# Probe: try to load the .node from Node. Pass the absolute path, escaped for
# JS string literal. Use process.dlopen because require() calls .node files
# through bindings/ which is too clever; dlopen is the raw loader Node uses.
$escapedPath = $NodePath.Replace('\', '\\')
$probeJs = @"
try {
  const fakeModule = { exports: {} };
  process.dlopen(fakeModule, '$escapedPath');
  process.stdout.write('LOAD_OK');
} catch (e) {
  const msg = (e && e.message) ? e.message : String(e);
  process.stdout.write('LOAD_FAIL:' + msg);
}
"@

$probeOutput = & node -e $probeJs 2>&1
$probeText = "$probeOutput"

if ($probeText.StartsWith('LOAD_OK')) {
    # The .node loaded under Node => its NMV equals Node's NMV ($runtimeNmv).
    # For Electron-targeted output that is a FAIL: it means the rebuild step
    # did not run (or built against the wrong target).
    if ($runtimeNmv -eq $ExpectedNmv) {
        Write-Result -status 'PASS' -message "Node's NMV equals expected ($ExpectedNmv) and .node loaded successfully." -extra @{ detected_nmv = $runtimeNmv; node_path = $NodePath; method = 'load_ok' }
        exit 0
    }
    Write-Result -status 'FAIL' -message "ABI mismatch: .node loaded under Node (NMV $runtimeNmv) but Electron expects NMV $ExpectedNmv. Run 'npx @electron/rebuild -f -o better-sqlite3' before packaging." -extra @{ detected_nmv = $runtimeNmv; expected_nmv = $ExpectedNmv; node_path = $NodePath; method = 'load_ok' }
    exit 1
}

# Parse the failure message. Looking for the standard Node loader error:
#   "The module '<path>' was compiled against a different Node.js version
#    using NODE_MODULE_VERSION <X>. This version of Node.js requires
#    NODE_MODULE_VERSION <Y>."
$pattern = 'NODE_MODULE_VERSION\s+(\d{2,4})\.\s*This version of Node\.js requires\s+NODE_MODULE_VERSION\s+(\d{2,4})'
$m = [regex]::Match($probeText, $pattern)
if ($m.Success) {
    $binaryNmv = [int]$m.Groups[1].Value
    $loaderNmv = [int]$m.Groups[2].Value
    if ($binaryNmv -eq $ExpectedNmv) {
        Write-Result -status 'PASS' -message "better_sqlite3.node ABI matches expected NMV $ExpectedNmv (Electron 33). Node loader (NMV $loaderNmv) correctly rejected it." -extra @{ detected_nmv = $binaryNmv; loader_nmv = $loaderNmv; node_path = $NodePath; method = 'mismatch_parse' }
        exit 0
    }
    Write-Result -status 'FAIL' -message "ABI mismatch: detected NMV $binaryNmv, expected $ExpectedNmv. Run 'npx @electron/rebuild -f -o better-sqlite3' before packaging." -extra @{ detected_nmv = $binaryNmv; loader_nmv = $loaderNmv; expected_nmv = $ExpectedNmv; node_path = $NodePath; method = 'mismatch_parse' }
    exit 1
}

# Unknown failure mode (e.g. file is corrupt, missing dependent DLL).
Write-Result -status 'FAIL' -message "Could not determine .node ABI. Probe output did not match expected patterns." -extra @{ probe_output = $probeText; node_path = $NodePath; expected_nmv = $ExpectedNmv; runtime_nmv = $runtimeNmv }
exit 1
