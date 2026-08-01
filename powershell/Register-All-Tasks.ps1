#Requires -Version 5.1
<#
.SYNOPSIS
    Applies the generated Phase 0 Scheduled Task manifest.
.DESCRIPTION
    Active entries are registered with fixed hidden command lines. Deferred and
    removal entries are unregistered. No task accepts a caller-supplied command,
    script path, or task name.
#>
param(
    [switch]$DryRun,
    [switch]$JsonOutput,
    [switch]$ForceRecreate,
    [string]$InstallDir = ''
)

$ErrorActionPreference = 'Stop'
trap {
    $errorPayload = @{ code = 'E_PS_UNHANDLED'; message = $_.Exception.Message } | ConvertTo-Json -Compress
    Write-Host "PCDOCTOR_ERROR:$errorPayload"
    exit 1
}

. (Join-Path $PSScriptRoot 'TaskSchedulerNative.ps1')

$manifestPath = Join-Path $PSScriptRoot 'task-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
    throw "Generated task manifest not found: $manifestPath"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schema_version -ne 1 -or $manifest.source_sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw 'Generated task manifest metadata is invalid'
}
$tasks = @($manifest.tasks)
if ($tasks.Count -eq 0) { throw 'Generated task manifest has no tasks' }

$fixedInstallDir = 'C:\Program Files\PCDoctor Workbench'
if ([string]::IsNullOrWhiteSpace($InstallDir)) { $InstallDir = $fixedInstallDir }
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not $InstallDir.Equals($fixedInstallDir, [StringComparison]::OrdinalIgnoreCase)) {
    throw "E_INSTALL_DIR_UNTRUSTED: expected '$fixedInstallDir', received '$InstallDir'"
}

$existingTaskNames = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
try {
    $taskService = New-Object -ComObject Schedule.Service
    $taskService.Connect()
    $rootFolder = $taskService.GetFolder('\')
    foreach ($scheduledTask in $rootFolder.GetTasks(1)) {
        [void]$existingTaskNames.Add([string]$scheduledTask.Name)
    }
} catch {
    # Exact-name schtasks queries remain the fallback; broad /Query is never used.
}

function Test-PCDoctorTaskExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($existingTaskNames.Contains($Name)) { return $true }
    $queryResult = Invoke-PCDoctorSchtasks -Arguments @('/Query', '/TN', $Name)
    if ($queryResult.ExitCode -eq 0) {
        [void]$existingTaskNames.Add($Name)
        return $true
    }
    return -not (Test-PCDoctorTaskQueryAbsent -Result $queryResult)
}

function Remove-PCDoctorManifestTask {
    param([Parameter(Mandatory = $true)][string]$Name)
    if (-not (Test-PCDoctorTaskExists -Name $Name)) { return 'absent' }
    if ($DryRun) { return 'removed' }
    $deleteResult = Invoke-PCDoctorSchtasks -Arguments @('/Delete', '/TN', $Name, '/F')
    if ($deleteResult.ExitCode -ne 0) { throw "Could not remove task '$Name': $($deleteResult.Output.Trim())" }
    [void]$existingTaskNames.Remove($Name)
    return 'removed'
}

function ConvertTo-TaskTriggerXml {
    param([Parameter(Mandatory = $true)]$Schedule)
    $start = if ($Schedule.PSObject.Properties.Name -contains 'at') {
        "2026-01-01T$($Schedule.at):00"
    } else { $null }
    $dayNames = @{
        MON = 'Monday'; TUE = 'Tuesday'; WED = 'Wednesday'; THU = 'Thursday'
        FRI = 'Friday'; SAT = 'Saturday'; SUN = 'Sunday'
    }
    $weekNumbers = @{ first = '1'; second = '2'; third = '3'; fourth = '4'; last = 'Last' }
    $months = '<January/><February/><March/><April/><May/><June/><July/><August/><September/><October/><November/><December/>'
    switch ([string]$Schedule.kind) {
        'logon' {
            return '<LogonTrigger><Enabled>true</Enabled></LogonTrigger>'
        }
        'daily' {
            return "<CalendarTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>"
        }
        'weekly' {
            $day = $dayNames[[string]$Schedule.day]
            if (-not $day) { throw "Invalid weekly day '$($Schedule.day)'" }
            return "<CalendarTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByWeek><WeeksInterval>1</WeeksInterval><DaysOfWeek><$day /></DaysOfWeek></ScheduleByWeek></CalendarTrigger>"
        }
        'monthly-day' {
            return "<CalendarTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByMonth><DaysOfMonth><Day>$($Schedule.day)</Day></DaysOfMonth><Months>$months</Months></ScheduleByMonth></CalendarTrigger>"
        }
        'monthly-weekday' {
            $day = $dayNames[[string]$Schedule.day]
            $week = $weekNumbers[[string]$Schedule.week]
            if (-not $day -or -not $week) { throw 'Invalid monthly weekday schedule' }
            return "<CalendarTrigger><StartBoundary>$start</StartBoundary><Enabled>true</Enabled><ScheduleByMonthDayOfWeek><Weeks><Week>$week</Week></Weeks><DaysOfWeek><$day /></DaysOfWeek><Months>$months</Months></ScheduleByMonthDayOfWeek></CalendarTrigger>"
        }
        'demand' { throw 'Demand-start tasks are deferred in Phase 0' }
        default { throw "Unsupported schedule kind '$($Schedule.kind)'" }
    }
}

function Resolve-PCDoctorTaskCommand {
    param([Parameter(Mandatory = $true)]$Task)
    if ($Task.executable -eq 'PCDoctor Workbench.exe') {
        $executable = Join-Path $InstallDir 'PCDoctor Workbench.exe'
        return @{
            executable = $executable
            arguments = '--hidden'
            required_path = $executable
        }
    }
    if ($Task.executable -ne 'powershell.exe') {
        throw "Manifest executable '$($Task.executable)' is not allowed"
    }
    $script = [string]$Task.script
    $fixedPrefix = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`""
    $tail = @($Task.arguments) -join ' '
    return @{
        executable = 'powershell.exe'
        arguments = if ($tail) { "$fixedPrefix $tail" } else { $fixedPrefix }
        required_path = $script
    }
}

function Get-PCDoctorXmlChildText {
    param(
        [Parameter(Mandatory = $true)]$Node,
        [Parameter(Mandatory = $true)][string]$LocalName
    )
    $child = $Node.SelectSingleNode("*[local-name()='$LocalName']")
    if ($null -eq $child) { return '' }
    return [string]$child.InnerText
}

function Test-PCDoctorAllMonths {
    param([Parameter(Mandatory = $true)]$ScheduleNode)

    $monthContainers = @($ScheduleNode.SelectNodes("*[local-name()='Months']"))
    if ($monthContainers.Count -ne 1) { return $false }
    $actualMonths = @($monthContainers[0].SelectNodes('*'))
    if ($actualMonths.Count -ne 12) { return $false }
    $expectedMonths = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($month in @(
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    )) { [void]$expectedMonths.Add($month) }
    foreach ($monthNode in $actualMonths) {
        if (-not $expectedMonths.Remove([string]$monthNode.LocalName)) { return $false }
    }
    return $expectedMonths.Count -eq 0
}

function Test-PCDoctorTriggerMatchesManifest {
    param(
        [Parameter(Mandatory = $true)][xml]$Definition,
        [Parameter(Mandatory = $true)]$Schedule
    )
    $triggerNodes = @($Definition.SelectNodes("/*[local-name()='Task']/*[local-name()='Triggers']/*"))
    if ($triggerNodes.Count -ne 1) { return $false }
    $trigger = $triggerNodes[0]
    $kind = [string]$Schedule.kind

    if ($kind -eq 'logon') {
        return $trigger.LocalName -ceq 'LogonTrigger' -and
            (Get-PCDoctorXmlChildText -Node $trigger -LocalName 'Enabled') -ceq 'true'
    }
    if ($trigger.LocalName -cne 'CalendarTrigger') { return $false }
    if ((Get-PCDoctorXmlChildText -Node $trigger -LocalName 'Enabled') -cne 'true') { return $false }

    $startBoundary = Get-PCDoctorXmlChildText -Node $trigger -LocalName 'StartBoundary'
    if ($startBoundary -cnotmatch 'T(?<time>\d{2}:\d{2})(?::\d{2})?') { return $false }
    if ($Matches.time -cne [string]$Schedule.at) { return $false }

    $dayNames = @{
        MON = 'Monday'; TUE = 'Tuesday'; WED = 'Wednesday'; THU = 'Thursday'
        FRI = 'Friday'; SAT = 'Saturday'; SUN = 'Sunday'
    }
    $weekNumbers = @{ first = '1'; second = '2'; third = '3'; fourth = '4'; last = 'Last' }
    switch ($kind) {
        'daily' {
            $scheduleNodes = @($trigger.SelectNodes("*[local-name()='ScheduleByDay']"))
            if ($scheduleNodes.Count -ne 1) { return $false }
            $scheduleNode = $scheduleNodes[0]
            return (Get-PCDoctorXmlChildText -Node $scheduleNode -LocalName 'DaysInterval') -ceq '1'
        }
        'weekly' {
            $scheduleNodes = @($trigger.SelectNodes("*[local-name()='ScheduleByWeek']"))
            if ($scheduleNodes.Count -ne 1) { return $false }
            $scheduleNode = $scheduleNodes[0]
            $dayContainers = @($scheduleNode.SelectNodes("*[local-name()='DaysOfWeek']"))
            if ($dayContainers.Count -ne 1) { return $false }
            $actualDays = @($dayContainers[0].SelectNodes('*'))
            if ($actualDays.Count -ne 1) { return $false }
            $actualDay = $actualDays[0]
            return (Get-PCDoctorXmlChildText -Node $scheduleNode -LocalName 'WeeksInterval') -ceq '1' -and
                $null -ne $actualDay -and $actualDay.LocalName -ceq $dayNames[[string]$Schedule.day]
        }
        'monthly-day' {
            $scheduleNodes = @($trigger.SelectNodes("*[local-name()='ScheduleByMonth']"))
            if ($scheduleNodes.Count -ne 1) { return $false }
            $scheduleNode = $scheduleNodes[0]
            $dayContainers = @($scheduleNode.SelectNodes("*[local-name()='DaysOfMonth']"))
            if ($dayContainers.Count -ne 1) { return $false }
            $actualDays = @($dayContainers[0].SelectNodes("*[local-name()='Day']"))
            return $actualDays.Count -eq 1 -and
                [string]$actualDays[0].InnerText -ceq [string]$Schedule.day -and
                (Test-PCDoctorAllMonths -ScheduleNode $scheduleNode)
        }
        'monthly-weekday' {
            $scheduleNodes = @($trigger.SelectNodes("*[local-name()='ScheduleByMonthDayOfWeek']"))
            if ($scheduleNodes.Count -ne 1) { return $false }
            $scheduleNode = $scheduleNodes[0]
            $weekContainers = @($scheduleNode.SelectNodes("*[local-name()='Weeks']"))
            $dayContainers = @($scheduleNode.SelectNodes("*[local-name()='DaysOfWeek']"))
            if ($weekContainers.Count -ne 1 -or $dayContainers.Count -ne 1) { return $false }
            $actualWeeks = @($weekContainers[0].SelectNodes("*[local-name()='Week']"))
            $actualDays = @($dayContainers[0].SelectNodes('*'))
            if ($actualWeeks.Count -ne 1 -or $actualDays.Count -ne 1) { return $false }
            return [string]$actualWeeks[0].InnerText -ceq $weekNumbers[[string]$Schedule.week] -and
                $actualDays[0].LocalName -ceq $dayNames[[string]$Schedule.day] -and
                (Test-PCDoctorAllMonths -ScheduleNode $scheduleNode)
        }
        default { return $false }
    }
}

function Test-PCDoctorTaskMatchesManifest {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)]$Command
    )
    $Name = [string]$Task.name
    $queryResult = Invoke-PCDoctorSchtasks -Arguments @('/Query', '/TN', $Name, '/XML', 'ONE')
    if ($queryResult.ExitCode -ne 0) { return $false }
    try { [xml]$definition = $queryResult.Output } catch { return $false }

    $actionNodes = @($definition.SelectNodes("/*[local-name()='Task']/*[local-name()='Actions']/*"))
    $principalNodes = @($definition.SelectNodes("/*[local-name()='Task']/*[local-name()='Principals']/*"))
    if ($actionNodes.Count -ne 1 -or $actionNodes[0].LocalName -cne 'Exec') { return $false }
    if ($principalNodes.Count -ne 1 -or $principalNodes[0].LocalName -cne 'Principal') { return $false }
    $action = $actionNodes[0]
    $principal = $principalNodes[0]
    $settings = $definition.SelectSingleNode("/*[local-name()='Task']/*[local-name()='Settings']")
    if ($null -eq $action -or $null -eq $principal -or $null -eq $settings) { return $false }

    $actualCommand = Get-PCDoctorXmlChildText -Node $action -LocalName 'Command'
    $actualArguments = Get-PCDoctorXmlChildText -Node $action -LocalName 'Arguments'
    $actualHidden = Get-PCDoctorXmlChildText -Node $settings -LocalName 'Hidden'
    if ($actualCommand -cne [string]$Command.executable) { return $false }
    if ($actualArguments -cne [string]$Command.arguments) { return $false }
    if ($actualHidden -cne 'true') { return $false }

    $actualUserId = Get-PCDoctorXmlChildText -Node $principal -LocalName 'UserId'
    $actualLogonType = Get-PCDoctorXmlChildText -Node $principal -LocalName 'LogonType'
    $actualRunLevel = Get-PCDoctorXmlChildText -Node $principal -LocalName 'RunLevel'
    if ($Task.context -eq 'interactive-user') {
        $expectedUserIds = @("$env:USERDOMAIN\$env:USERNAME")
        try { $expectedUserIds += [Security.Principal.WindowsIdentity]::GetCurrent().User.Value } catch { }
        if ($actualUserId -notin $expectedUserIds -or
            $actualLogonType -cne 'InteractiveToken' -or $actualRunLevel -cne 'LeastPrivilege') {
            return $false
        }
    } elseif ($Task.context -eq 'system') {
        if ($actualUserId -cne 'S-1-5-18' -or
            $actualLogonType -notin @('', 'ServiceAccount') -or $actualRunLevel -cne 'HighestAvailable') {
            return $false
        }
    } else {
        return $false
    }

    return Test-PCDoctorTriggerMatchesManifest -Definition $definition -Schedule $Task.schedule
}

function New-PCDoctorTaskXml {
    param(
        [Parameter(Mandatory = $true)]$Task,
        [Parameter(Mandatory = $true)]$Command
    )
    $triggerXml = ConvertTo-TaskTriggerXml -Schedule $Task.schedule
    if ($Task.context -eq 'interactive-user') {
        $runUser = [Security.SecurityElement]::Escape("$env:USERDOMAIN\$env:USERNAME")
        $principalXml = "<Principal id=`"Author`"><UserId>$runUser</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>"
    } elseif ($Task.context -eq 'system') {
        # The canonical validator rejects active SYSTEM tasks beneath ProgramData.
        $principalXml = '<Principal id="Author"><UserId>S-1-5-18</UserId><RunLevel>HighestAvailable</RunLevel></Principal>'
    } else {
        throw "Unsupported task context '$($Task.context)'"
    }
    $executableXml = [Security.SecurityElement]::Escape([string]$Command.executable)
    $argumentsXml = [Security.SecurityElement]::Escape([string]$Command.arguments)
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>PCDoctor task manifest schema 1</Author></RegistrationInfo>
  <Triggers>$triggerXml</Triggers>
  <Principals>$principalXml</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT2H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>$executableXml</Command><Arguments>$argumentsXml</Arguments></Exec></Actions>
</Task>
"@
}

function Register-PCDoctorManifestTask {
    param([Parameter(Mandatory = $true)]$Task)
    $command = Resolve-PCDoctorTaskCommand -Task $Task
    if (-not (Test-Path -LiteralPath $command.required_path -PathType Leaf)) {
        throw "Fixed task target is missing: $($command.required_path)"
    }
    $taskExists = Test-PCDoctorTaskExists -Name ([string]$Task.name)
    if ($taskExists -and -not $ForceRecreate -and
        (Test-PCDoctorTaskMatchesManifest -Task $Task -Command $command)) {
        return @{ status = 'already_registered'; command = "$($command.executable) $($command.arguments)" }
    }
    $taskXml = New-PCDoctorTaskXml -Task $Task -Command $command
    if ($DryRun) {
        return @{ status = 'registered'; command = "$($command.executable) $($command.arguments)" }
    }
    try {
        if ($null -eq $rootFolder) {
            $taskService = New-Object -ComObject Schedule.Service
            $taskService.Connect()
            $rootFolder = $taskService.GetFolder('\')
        }
        $taskCreateOrUpdate = 6
        if ($Task.context -eq 'interactive-user') {
            $registrationUser = "$env:USERDOMAIN\$env:USERNAME"
            $taskLogonType = 3 # TASK_LOGON_INTERACTIVE_TOKEN
        } else {
            $registrationUser = 'SYSTEM'
            $taskLogonType = 5 # TASK_LOGON_SERVICE_ACCOUNT
        }
        [void]$rootFolder.RegisterTask(
            [string]$Task.name, $taskXml, $taskCreateOrUpdate,
            $registrationUser, $null, $taskLogonType, $null
        )
    } catch {
        throw "Could not register task '$($Task.name)' from in-memory XML: $($_.Exception.Message)"
    }
    [void]$existingTaskNames.Add([string]$Task.name)
    return @{ status = 'registered'; command = "$($command.executable) $($command.arguments)" }
}

$stopwatch = [Diagnostics.Stopwatch]::StartNew()
$results = @()
foreach ($task in $tasks) {
    $row = [ordered]@{
        id = [string]$task.id
        name = [string]$task.name
        state = [string]$task.state
        status = 'failed'
    }
    try {
        foreach ($legacyName in @($task.migration.legacy_names)) {
            [void](Remove-PCDoctorManifestTask -Name ([string]$legacyName))
        }
        if ($task.state -eq 'active') {
            $registration = Register-PCDoctorManifestTask -Task $task
            $row.status = $registration.status
            $row.command = $registration.command
        } else {
            $row.status = Remove-PCDoctorManifestTask -Name ([string]$task.name)
        }
    } catch {
        $row.status = 'failed'
        $row.output = $_.Exception.Message
    }
    $results += $row
}
$stopwatch.Stop()

$failed = @($results | Where-Object { $_.status -eq 'failed' }).Count
$result = [ordered]@{
    success = $failed -eq 0
    source_sha256 = [string]$manifest.source_sha256
    duration_ms = $stopwatch.ElapsedMilliseconds
    results = $results
    message = if ($failed -eq 0) { "Applied $($tasks.Count) manifest entries" } else { "$failed manifest entries failed" }
}
$result | ConvertTo-Json -Depth 8 -Compress
if ($failed -eq 0) { exit 0 } else { exit 1 }
