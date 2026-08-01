#Requires -Version 5.1
<#
.SYNOPSIS
    Compatibility entry point for the retired per-task registrar.
.DESCRIPTION
    All registration now delegates to the generated manifest consumer.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [switch]$ForceRecreate,
    [string]$InstallDir = ''
)

$registrar = Join-Path $PSScriptRoot 'Register-All-Tasks.ps1'
$arguments = @()
if ($DryRun) { $arguments += '-DryRun' }
if ($JsonOutput) { $arguments += '-JsonOutput' }
if ($ForceRecreate) { $arguments += '-ForceRecreate' }
if ($InstallDir) { $arguments += @('-InstallDir', $InstallDir) }
& $registrar @arguments
exit $LASTEXITCODE
