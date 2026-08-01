#Requires -Version 5.1
param(
    [ValidateRange(60, 525600)]
    [int]$MinimumAgeMinutes = 1440
)

$ErrorActionPreference = 'Stop'
$queueRoot = 'C:\ProgramData\PCDoctorWorkerQueue'
$expectedRoot = [IO.Path]::GetFullPath('C:\ProgramData\PCDoctorWorkerQueue').TrimEnd('\')

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'E_NOT_ADMIN: stale worker-session cleanup requires an administrator token'
}

$resolvedRoot = [IO.Path]::GetFullPath($queueRoot).TrimEnd('\')
if (-not $resolvedRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "E_ROOT_MISMATCH: $resolvedRoot"
}
if (-not [IO.Directory]::Exists($resolvedRoot)) { exit 0 }

$rootItem = Get-Item -LiteralPath $resolvedRoot -Force
if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'E_ROOT_REPARSE: queue root is a reparse point'
}

$cutoff = [DateTime]::UtcNow.AddMinutes(-$MinimumAgeMinutes)
foreach ($leaf in [IO.Directory]::EnumerateDirectories($resolvedRoot, '*', [IO.SearchOption]::TopDirectoryOnly)) {
    $item = Get-Item -LiteralPath $leaf -Force
    if ($item.Name -cnotmatch '^[0-9a-f]{32}\z') { continue }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    if ($item.LastWriteTimeUtc -gt $cutoff) { continue }
    $fullLeaf = [IO.Path]::GetFullPath($item.FullName)
    if (-not [IO.Path]::GetDirectoryName($fullLeaf).TrimEnd('\').Equals(
        $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) { continue }
    Remove-Item -LiteralPath $fullLeaf -Recurse -Force
}

exit 0
