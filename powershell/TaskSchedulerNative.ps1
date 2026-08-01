#Requires -Version 5.1
<#
.SYNOPSIS
    Runs schtasks.exe without allowing PowerShell 5.1 stderr promotion to mask
    the native process exit code.
#>

$script:PCDoctorSchtasksPath = Join-Path ([Environment]::GetFolderPath(
    [Environment+SpecialFolder]::System
)) 'schtasks.exe'

function Invoke-PCDoctorSchtasks {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Arguments
    )

    $previousErrorActionPreference = $ErrorActionPreference
    try {
        # Windows PowerShell 5.1 can promote native stderr records to terminating
        # NativeCommandError exceptions when the caller uses Stop. schtasks uses
        # stderr for ordinary outcomes (including an absent exact-name query), so
        # capture both streams under Continue and make the exit code authoritative.
        $ErrorActionPreference = 'Continue'
        $output = & $script:PCDoctorSchtasksPath @Arguments 2>&1 | Out-String
        $exitCode = [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    [pscustomobject]@{
        ExitCode = $exitCode
        Output = [string]$output
    }
}

function Test-PCDoctorTaskQueryAbsent {
    param([Parameter(Mandatory = $true)]$Result)

    if ($Result.ExitCode -eq 0) { return $false }
    # Only a recognized not-found result is absence. Access denied, scheduler
    # failure, command-launch failure, and unknown/localized errors fail closed
    # as "possibly present" so migration cannot falsely report removal.
    return [string]$Result.Output -match (
        '(?i)(cannot find the file specified|cannot find the task specified|' +
        'the system cannot find|does not exist|0x80070002|ERROR_FILE_NOT_FOUND)'
    )
}
