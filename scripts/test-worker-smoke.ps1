<#
.SYNOPSIS
    Exercises the authenticated worker in a non-elevated, temp-only test mode.

.DESCRIPTION
    This gate never uses Start-Process, RunAs, ProgramData, production queues, or
    maintenance scripts. Each shell receives a temporary BasePath containing only
    a generated test-echo fixture and the worker's -TestMode switch. TestMode can
    validate production envelopes but can execute only that safe fixture.

    The smoke covers the literal cross-language HMAC fixture, shape, session, time,
    HMAC, replay, action schema, reboot denial, and atomic-result failure behavior.

.NOTES
    PowerShell 5.1 compatible. The capability is assigned only inside the background
    job process, inherited by the worker child, and removed from the job immediately.
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$CapabilityEnvironmentName = 'PCDOCTOR_WORKER_CAPABILITY_V2'
$FixtureNow = [int64]1770000001000
$FixtureCapabilityBytes = [byte[]](0..31)
$FixtureCapability = [Convert]::ToBase64String($FixtureCapabilityBytes)
$FixtureSession = '00112233445566778899aabbccddeeff'
$FixtureCanonical = '{"action":"set-service-startup","expires_at":1770000025000,"id":"ffeeddccbbaa99887766554433221100","issued_at":1770000000000,"nonce":"0123456789abcdeffedcba9876543210","params":{"service":"Spooler","startup_type":"Disabled"},"session_id":"00112233445566778899aabbccddeeff","version":2}'
$FixtureHmac = 'd10c2b6eec700463d16d59144aaa075962db31d1826422ad9007e9c670af2e8f'
$NonAsciiValue = 'Caf' + [char]0x00E9 + ' ' + [char]0xD83D + [char]0xDE80 +
    ' ' + [char]0x4E2D + [char]0x6587
$NonAsciiFixtureCanonical = '{"action":"test-echo","expires_at":1770000021000,"id":"e0000000000000000000000000000000","issued_at":1770000000000,"nonce":"e0000000000000000000000000000001","params":{"value":"' +
    $NonAsciiValue + '"},"session_id":"00112233445566778899aabbccddeeff","version":2}'
$NonAsciiFixtureHmac = '2054cbe979c250195262d4e124095a5d2a815b858768bb68336394e6b53669c4'

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition)
$worker = Join-Path $repoRoot 'powershell\worker\Elevated-Worker.ps1'
$serviceStartupAction = Join-Path $repoRoot 'powershell\actions\Set-ServiceStartup.ps1'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) {
    Write-Host "[FAIL] Worker script not found at $worker"
    exit 1
}

function ConvertTo-Hex {
    param([Parameter(Mandatory=$true)][byte[]]$Bytes)
    return (($Bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

function Get-TestHmac {
    param([Parameter(Mandatory=$true)][string]$Canonical)
    $hmac = New-Object System.Security.Cryptography.HMACSHA256 -ArgumentList (, $FixtureCapabilityBytes)
    try {
        return ConvertTo-Hex -Bytes $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($Canonical))
    } finally {
        $hmac.Dispose()
    }
}

function Assert-ExactJsonProperties {
    param(
        [Parameter(Mandatory=$true)]$Value,
        [Parameter(Mandatory=$true)][string[]]$Expected,
        [Parameter(Mandatory=$true)][string]$Label
    )
    $actual = @($Value.PSObject.Properties | ForEach-Object { $_.Name })
    if ($actual.Count -ne $Expected.Count) { throw "$Label property count is invalid" }
    foreach ($name in $Expected) {
        if ($actual -cnotcontains $name) { throw "$Label is missing exact property: $name" }
    }
}

function Assert-SignedHeartbeat {
    param([Parameter(Mandatory=$true)]$Heartbeat)
    Assert-ExactJsonProperties $Heartbeat `
        @('version', 'session_id', 'worker_pid', 'issued_at', 'expires_at', 'nonce', 'hmac_sha256') `
        'Heartbeat'
    if ($Heartbeat.version -ne 2 -or $Heartbeat.session_id -cne $FixtureSession -or
        [int64]$Heartbeat.worker_pid -le 0 -or "$($Heartbeat.nonce)" -notmatch '^[0-9a-f]{32}\z' -or
        "$($Heartbeat.hmac_sha256)" -notmatch '^[0-9a-f]{64}\z') {
        throw 'Heartbeat field type or format is invalid'
    }
    $unsigned = [ordered]@{
        expires_at = [int64]$Heartbeat.expires_at
        issued_at = [int64]$Heartbeat.issued_at
        nonce = "$($Heartbeat.nonce)"
        session_id = "$($Heartbeat.session_id)"
        version = [int]$Heartbeat.version
        worker_pid = [int64]$Heartbeat.worker_pid
    }
    $canonical = $unsigned | ConvertTo-Json -Depth 8 -Compress
    if ((Get-TestHmac -Canonical $canonical) -cne "$($Heartbeat.hmac_sha256)") {
        throw 'Heartbeat HMAC does not match the independent smoke implementation'
    }
}

function Assert-SignedResult {
    param(
        [Parameter(Mandatory=$true)]$Result,
        [Parameter(Mandatory=$true)][string]$Id
    )
    $unionProperty = if ($Result.success -eq $true) { 'data' } else { 'error' }
    Assert-ExactJsonProperties $Result `
        @('version', 'session_id', 'id', 'action', 'success', 'duration_ms', $unionProperty,
            'issued_at', 'nonce', 'hmac_sha256') `
        'Result'
    if ($Result.version -ne 2 -or $Result.session_id -cne $FixtureSession -or $Result.id -cne $Id -or
        "$($Result.action)".Length -lt 1 -or [int64]$Result.duration_ms -lt 0 -or
        "$($Result.nonce)" -notmatch '^[0-9a-f]{32}\z' -or
        "$($Result.hmac_sha256)" -notmatch '^[0-9a-f]{64}\z') {
        throw "Signed result fields are invalid for $Id"
    }

    $unsigned = [ordered]@{ action = "$($Result.action)" }
    if ($Result.success -eq $true) { $unsigned['data'] = $Result.data }
    $unsigned['duration_ms'] = [int64]$Result.duration_ms
    if ($Result.success -ne $true) {
        Assert-ExactJsonProperties $Result.error @('code', 'message') 'Result error'
        $unsigned['error'] = [ordered]@{
            code = "$($Result.error.code)"
            message = "$($Result.error.message)"
        }
    }
    $unsigned['id'] = "$($Result.id)"
    $unsigned['issued_at'] = [int64]$Result.issued_at
    $unsigned['nonce'] = "$($Result.nonce)"
    $unsigned['session_id'] = "$($Result.session_id)"
    $unsigned['success'] = [bool]$Result.success
    $unsigned['version'] = [int]$Result.version
    $canonical = $unsigned | ConvertTo-Json -Depth 8 -Compress
    if ((Get-TestHmac -Canonical $canonical) -cne "$($Result.hmac_sha256)") {
        throw "Result HMAC does not match the independent smoke implementation for $Id"
    }
}

function Assert-WorkerArgumentMaps {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Worker AST could not be parsed for argument-map tests' }
    $definitions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $true))
    foreach ($name in @('Throw-WorkerError', 'Assert-ExactKeys', 'Assert-StringParam',
            'Assert-IntegerParam', 'Add-DryRunArgument', 'Get-ActionArguments')) {
        $definition = @($definitions | Where-Object { $_.Name -ceq $name })[0]
        if (-not $definition) { throw "Worker function missing from argument-map test: $name" }
        Invoke-Expression $definition.Extent.Text
    }

    $TestMode = $true
    $cases = @(
        @{ Action='set-service-startup'; Params=@{service='Spooler';startup_type='Disabled'}; Expected=@('-Service','Spooler','-StartupType','Disabled','-JsonOutput') },
        @{ Action='stop-service'; Params=@{service='Spooler';dry_run=$true}; Expected=@('-Service','Spooler','-DryRun','-JsonOutput') },
        @{ Action='start-service'; Params=@{service='Spooler'}; Expected=@('-Service','Spooler','-JsonOutput') },
        @{ Action='restart-service'; Params=@{service='Spooler'}; Expected=@('-ServiceName','Spooler','-JsonOutput') },
        @{ Action='kill-process'; Params=@{target='notepad'}; Expected=@('-Target','notepad','-JsonOutput') },
        @{ Action='set-process-priority'; Params=@{target=[int64]123;class='High'}; Expected=@('-Target','123','-Class','High','-JsonOutput') },
        @{ Action='set-process-affinity'; Params=@{target=[int64]123;mask=[int64]3}; Expected=@('-Target','123','-Mask','3','-JsonOutput') },
        @{ Action='suspend-process'; Params=@{target=[int64]123}; Expected=@('-Target','123','-JsonOutput') },
        @{ Action='resume-process'; Params=@{target=[int64]123}; Expected=@('-Target','123','-JsonOutput') }
    )
    foreach ($case in $cases) {
        $params = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
        foreach ($key in $case.Params.Keys) { $params.Add($key, $case.Params[$key]) }
        $actual = @(Get-ActionArguments -Action $case.Action -Params $params)
        if (($actual -join [char]0) -cne ($case.Expected -join [char]0)) {
            throw "Explicit argument map mismatch for $($case.Action): $($actual -join ' ')"
        }
    }

    $invalidSafeNames = @(
        '*', '?', 'name[0]', 'bad/name', 'bad\name', 'bad name', "bad`tname",
        "bad`nname", "badname`n", (('A' * 128) + "`n"), 'bad;name', 'café', ('a' * 129)
    )
    foreach ($action in @('set-service-startup', 'stop-service', 'start-service', 'restart-service')) {
        foreach ($value in $invalidSafeNames) {
            $params = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
            $params.Add('service', $value)
            if ($action -ceq 'set-service-startup') { $params.Add('startup_type', 'Disabled') }
            $accepted = $true
            try { [void](Get-ActionArguments -Action $action -Params $params) }
            catch {
                $accepted = $false
                if ($_.Exception.Data['code'] -cne 'E_INVALID_PARAMS') { throw }
            }
            if ($accepted) { throw "$action accepted unsafe service name: $value" }
        }
    }
    foreach ($value in $invalidSafeNames) {
        $params = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
        $params.Add('target', $value)
        $accepted = $true
        try { [void](Get-ActionArguments -Action 'kill-process' -Params $params) }
        catch {
            $accepted = $false
            if ($_.Exception.Data['code'] -cne 'E_INVALID_PARAMS') { throw }
        }
        if ($accepted) { throw "kill-process accepted unsafe target: $value" }
    }
}

function Assert-WorkerQueueAclModel {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Worker AST could not be parsed for queue ACL model tests' }
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'New-ProductionQueueLeafSecurity'
    }, $true))[0]
    if (-not $definition) { throw 'Worker production queue ACL factory is missing' }
    Invoke-Expression $definition.Extent.Text

    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $security = New-ProductionQueueLeafSecurity -UserSidText $userSid.Value
    $adminSid = 'S-1-5-32-544'
    $systemSid = 'S-1-5-18'
    if (-not $security.AreAccessRulesProtected -or
        $security.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $adminSid) {
        throw 'Production queue leaf is not protected and administrator-owned'
    }

    $rules = @($security.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $userRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $userSid.Value })
    if ($rules.Count -ne 4 -or $userRules.Count -ne 2) {
        throw 'Production queue leaf ACL does not contain the exact four-rule model'
    }
    foreach ($trustedSid in @($adminSid, $systemSid)) {
        $trustedRule = @($rules | Where-Object { $_.IdentityReference.Value -ceq $trustedSid })
        if ($trustedRule.Count -ne 1 -or
            $trustedRule[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $trustedRule[0].FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $trustedRule[0].InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or
            $trustedRule[0].PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            throw "Production queue leaf trusted rule is invalid for $trustedSid"
        }
    }

    $directoryRule = @($userRules | Where-Object {
        $_.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::None -and
        $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
    })
    $fileRule = @($userRules | Where-Object {
        $_.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::ObjectInherit -and
        $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::InheritOnly
    })
    if ($directoryRule.Count -ne 1 -or $fileRule.Count -ne 1) {
        throw 'Production queue leaf user rules do not separate directory and child-file rights'
    }

    $requiredDirectoryRights = [int64](
        [Security.AccessControl.FileSystemRights]::ListDirectory -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::Traverse -bor
        [Security.AccessControl.FileSystemRights]::ReadAttributes -bor
        [Security.AccessControl.FileSystemRights]::ReadPermissions -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    )
    $forbiddenDirectoryRights = [int64](
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    if ([int64]$directoryRule[0].FileSystemRights -ne $requiredDirectoryRights -or
        ([int64]$directoryRule[0].FileSystemRights -band $forbiddenDirectoryRights) -ne 0) {
        throw 'Production queue leaf grants the user unsafe or insufficient directory rights'
    }
    $requiredFileRights = [int64](
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    )
    if ([int64]$fileRule[0].FileSystemRights -ne $requiredFileRights) {
        throw 'Production queue leaf child-file rule cannot support atomic temp rename and cleanup'
    }
}

function Assert-WorkerSourceSafety {
    $source = [IO.File]::ReadAllText($worker)
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Worker AST could not be parsed for source-safety tests' }
    $forbiddenQueueCommands = @($ast.FindAll({
        param($node)
        if ($node -isnot [Management.Automation.Language.CommandAst]) { return $false }
        $name = $node.GetCommandName()
        if ([string]::IsNullOrWhiteSpace($name)) { return $false }
        $unqualified = ($name -split '\\')[-1]
        return @('Get-ChildItem', 'Sort-Object') -icontains $unqualified
    }, $true))
    if ($forbiddenQueueCommands.Count -ne 0) {
        throw 'Worker source contains a global Get-ChildItem or Sort-Object command'
    }
    if ($source -notmatch [regex]::Escape("`$script:ProductionQueueRoot = 'C:\ProgramData\PCDoctorWorkerQueue'")) {
        throw 'Worker does not pin the production queue root outside PCDOCTOR_ROOT'
    }
    if ($source -notmatch '\[IO\.Directory\]::EnumerateFiles\(' -or
        $source -match '\[IO\.Directory\]::GetFiles\(' -or
        $source -notmatch '\$MaxCommandFilesPerIteration') {
        throw 'Worker command backlog is not lazily enumerated with an iteration cap'
    }
    if ($source -match 'Get-ChildItem[^\r\n]*\*\.cmd\.json' -or
        $source -match 'Sort-Object[^\r\n]*Name') {
        throw 'Worker still materializes or globally sorts the command backlog'
    }
    if ($source -match '\[IO\.Directory\]::CreateDirectory\(\$QueueDir\)' -or
        $source -match 'Set-Acl[^\r\n]*\$QueueDir' -or
        $source -notmatch "PSEdition -cne 'Desktop'") {
        throw 'Production queue creation permits a non-atomic create-then-ACL fallback'
    }
}

function Assert-WorkerPureHelpers {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($worker, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Worker AST could not be parsed for pure helper tests' }
    $definitions = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst]
    }, $true))
    $names = @(
        'Throw-WorkerError', 'Test-SafeInteger', 'Skip-StrictJsonWhitespace',
        'Read-StrictJsonHexUnit', 'Read-StrictJsonString', 'Read-StrictJsonNumber',
        'Read-StrictJsonObject', 'Read-StrictJsonArray', 'Read-StrictJsonValue',
        'ConvertFrom-StrictJson', 'ConvertTo-CanonicalJsonString', 'ConvertTo-CanonicalJson',
        'Read-BoundedUtf8File', 'Test-ExpectedProductionQueueRootOwner'
    )
    foreach ($name in $names) {
        $definition = @($definitions | Where-Object { $_.Name -ceq $name })[0]
        if (-not $definition) { throw "Worker function missing from pure helper test: $name" }
        Invoke-Expression $definition.Extent.Text
    }

    if (-not (Test-ExpectedProductionQueueRootOwner -OwnerSid 'S-1-5-32-544')) {
        throw 'Production queue root rejected BUILTIN\Administrators ownership'
    }
    foreach ($otherOwner in @(
        'S-1-5-18',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464',
        'S-1-5-21-1000'
    )) {
        if (Test-ExpectedProductionQueueRootOwner -OwnerSid $otherOwner) {
            throw "Production queue root accepted non-Administrators owner: $otherOwner"
        }
    }

    $json = '{"empty":[],"items":[1],"path":"C:\\Windows","quote":"a\"b"}'
    $parsed = ConvertFrom-StrictJson -Text $json
    if ($parsed['items'] -isnot [Array] -or $parsed['items'].Count -ne 1 -or
        $parsed['empty'] -isnot [Array] -or $parsed['empty'].Count -ne 0) {
        throw 'Strict parser did not preserve one-element and empty JSON arrays'
    }
    if ((ConvertTo-CanonicalJson -Value $parsed) -cne $json) {
        throw 'Strict parser and canonical serializer disagree on escaped JSON'
    }

    # A raw UTF-8 non-BMP scalar becomes a UTF-16 surrogate pair in both
    # PowerShell runtimes. It must canonicalize identically to an escaped pair.
    $rawNonBmpJson = '{"value":"' + $NonAsciiValue + '"}'
    $escapedNonBmpJson = '{"value":"Caf\u00e9 \ud83d\ude80 \u4e2d\u6587"}'
    $parsedRawNonBmp = ConvertFrom-StrictJson -Text $rawNonBmpJson
    $parsedEscapedNonBmp = ConvertFrom-StrictJson -Text $escapedNonBmpJson
    if ($parsedRawNonBmp['value'] -cne $NonAsciiValue -or
        $parsedEscapedNonBmp['value'] -cne $NonAsciiValue -or
        (ConvertTo-CanonicalJson -Value $parsedRawNonBmp) -cne $rawNonBmpJson -or
        (ConvertTo-CanonicalJson -Value $parsedEscapedNonBmp) -cne $rawNonBmpJson) {
        throw 'Strict JSON did not normalize raw and escaped non-BMP strings identically'
    }
    foreach ($loneSurrogate in @([char]0xD83D, [char]0xDE80)) {
        $loneAccepted = $true
        try { [void](ConvertFrom-StrictJson -Text ('{"value":"' + $loneSurrogate + '"}')) }
        catch { $loneAccepted = $false }
        if ($loneAccepted) { throw 'Strict parser accepted a lone raw JSON surrogate' }
    }
    foreach ($invalidJson in @('{"value":TRUE}', '{"value":"\N"}')) {
        $invalidAccepted = $true
        try { [void](ConvertFrom-StrictJson -Text $invalidJson) } catch { $invalidAccepted = $false }
        if ($invalidAccepted) { throw "Strict parser accepted non-JSON case variant: $invalidJson" }
    }

    $duplicateRejected = $false
    try { [void](ConvertFrom-StrictJson -Text '{"id":"first","id":"second"}') }
    catch { $duplicateRejected = $_.Exception.Message -like 'Duplicate JSON property:*' }
    if (-not $duplicateRejected) {
        throw 'Strict parser did not reject a duplicate JSON property'
    }

    $oversizedPath = Join-Path $env:TEMP "pcdoctor-bounded-read-$([guid]::NewGuid().ToString('N')).json"
    try {
        [IO.File]::WriteAllText($oversizedPath, ('x' * 17), (New-Object Text.UTF8Encoding($false)))
        $caughtCode = $null
        try { [void](Read-BoundedUtf8File -Path $oversizedPath -MaxBytes 16) }
        catch { $caughtCode = $_.Exception.Data['code'] }
        if ($caughtCode -cne 'E_BAD_CMD') { throw 'Bounded worker read did not reject an oversized file' }
    } finally {
        Remove-Item -LiteralPath $oversizedPath -Force -ErrorAction SilentlyContinue
    }
}

function Assert-ServiceStartupPureHelpers {
    $tokens = $null
    $errors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile($serviceStartupAction, [ref]$tokens, [ref]$errors)
    if ($errors.Count -gt 0) { throw 'Set-ServiceStartup AST could not be parsed for pure helper tests' }
    $definition = @($ast.FindAll({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -ceq 'Get-TrustedScExecutable'
    }, $true))[0]
    if (-not $definition) { throw 'Set-ServiceStartup is missing Get-TrustedScExecutable' }
    Invoke-Expression $definition.Extent.Text

    $savedSystemRoot = $env:SystemRoot
    try {
        $env:SystemRoot = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
        $expected = Join-Path $env:SystemRoot 'System32\sc.exe'
        $actual = Get-TrustedScExecutable
        if (-not [IO.Path]::IsPathRooted($actual) -or
            -not [IO.Path]::GetFullPath($actual).Equals(
                [IO.Path]::GetFullPath($expected), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Set-ServiceStartup did not resolve the absolute SystemRoot sc.exe path'
        }
    } finally {
        $env:SystemRoot = $savedSystemRoot
    }
}

function New-SignedEnvelope {
    param(
        [Parameter(Mandatory=$true)][string]$Id,
        [Parameter(Mandatory=$true)][string]$Action,
        [Parameter(Mandatory=$true)]$Params,
        [Parameter(Mandatory=$true)][string]$Nonce,
        [string]$SessionId = $FixtureSession,
        [int64]$IssuedAt = $FixtureNow - 1000,
        [int64]$ExpiresAt = $FixtureNow + 20000,
        [string]$PolicyId,
        [string]$IntentId
    )

    # Ordered keys are already in canonical ordinal order. All smoke values are
    # ASCII strings, integers, booleans, or null, so ConvertTo-Json is independent
    # from the worker's strict parser and canonicalizer for these fixtures.
    $unsigned = [ordered]@{
        action     = $Action
        expires_at = $ExpiresAt
        id         = $Id
    }
    if ($PSBoundParameters.ContainsKey('IntentId')) { $unsigned['intent_id'] = $IntentId }
    $unsigned['issued_at'] = $IssuedAt
    $unsigned['nonce'] = $Nonce
    $unsigned['params'] = $Params
    if ($PSBoundParameters.ContainsKey('PolicyId')) { $unsigned['policy_id'] = $PolicyId }
    $unsigned['session_id'] = $SessionId
    $unsigned['version'] = 2
    $canonical = $unsigned | ConvertTo-Json -Depth 8 -Compress
    $envelope = [ordered]@{
        version     = 2
        session_id  = $SessionId
        id          = $Id
        action      = $Action
        params      = $Params
        issued_at   = $IssuedAt
        expires_at  = $ExpiresAt
        nonce       = $Nonce
        hmac_sha256 = Get-TestHmac -Canonical $canonical
    }
    if ($PSBoundParameters.ContainsKey('PolicyId')) { $envelope['policy_id'] = $PolicyId }
    if ($PSBoundParameters.ContainsKey('IntentId')) { $envelope['intent_id'] = $IntentId }
    return $envelope
}

function Write-TestJson {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)]$Value
    )
    $json = if ($Value -is [string]) { $Value } else { $Value | ConvertTo-Json -Depth 8 -Compress }
    [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Read-AtomicArtifactText {
    param([Parameter(Mandatory=$true)][string]$Path)
    try {
        $stream = [IO.File]::Open(
            $Path,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]'ReadWrite, Delete')
    } catch {
        # Rename publication may make the path transiently unavailable or busy,
        # but a successful read must always be one complete authenticated version.
        if ($_.Exception.InnerException -is [IO.IOException] -or
            $_.Exception -is [IO.IOException]) { return $null }
        throw
    }
    try {
        $reader = New-Object IO.StreamReader($stream, (New-Object Text.UTF8Encoding($false, $true)), $true)
        try { return $reader.ReadToEnd() }
        finally { $reader.Dispose() }
    } finally {
        $stream.Dispose()
    }
}

function Read-WorkerArtifactJson {
    param([Parameter(Mandatory=$true)][string]$Path)
    $text = Read-AtomicArtifactText -Path $Path
    if ($null -eq $text) { throw "Worker artifact is temporarily unavailable: $Path" }
    return ConvertFrom-Json -InputObject $text
}

function New-SecureTestQueue {
    param([Parameter(Mandatory=$true)][string]$Path)
    $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    foreach ($sid in @($userSid, $adminSid, $systemSid)) {
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )
        $security.AddAccessRule($rule)
    }
    # The Directory.CreateDirectory(path, security) overload is absent from
    # PowerShell 7's .NET runtime. This temp-only harness creates then immediately
    # replaces the inherited ACL before placing any command or capability data.
    [IO.Directory]::CreateDirectory($Path) | Out-Null
    Set-Acl -LiteralPath $Path -AclObject $security
    return $userSid.Value
}

function New-TestActionFixture {
    param([Parameter(Mandatory=$true)][string]$BasePath)
    $actionDirectory = Join-Path $BasePath 'test-actions'
    New-Item -ItemType Directory -Path $actionDirectory -Force | Out-Null
    $actionPath = Join-Path $actionDirectory 'Test-Echo.ps1'
    $source = @'
param(
    [Parameter(Mandatory=$true)][string]$Value,
    [int]$DelayMilliseconds = 0,
    [switch]$JsonOutput
)
if ($DelayMilliseconds -gt 0) { Start-Sleep -Milliseconds $DelayMilliseconds }
[ordered]@{
    comspec = $env:ComSpec
    echo = $Value
    host_path = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    path = $env:PATH
    pathext = $env:PATHEXT
    psmodulepath = $env:PSModulePath
    system_root = $env:SystemRoot
    windir = $env:windir
} | ConvertTo-Json -Compress
'@
    [IO.File]::WriteAllText($actionPath, $source, (New-Object Text.UTF8Encoding($false)))
}

function Assert-TrustedActionHostAndFreshHeartbeat {
    param(
        [Parameter(Mandatory=$true)][string]$ShellPath,
        [Parameter(Mandatory=$true)][string]$ShellName
    )
    $queueRootPath = Join-Path $env:TEMP "pcdoctor-worker-host-smoke-$([guid]::NewGuid().ToString('N'))"
    $queuePath = Join-Path $queueRootPath $FixtureSession
    $job = $null
    try {
        $queueSid = New-SecureTestQueue -Path $queuePath
        $basePath = Join-Path $queuePath 'test-base'
        New-Item -ItemType Directory -Path $basePath | Out-Null
        New-TestActionFixture -BasePath $basePath

        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $command = New-SignedEnvelope -Id 'f0000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ delay_ms = [int64]1400; value = 'trusted-boundary' }) `
            -Nonce 'f0000000000000000000000000000001' -IssuedAt ($now - 100) -ExpiresAt ($now + 25000)
        Write-TestJson -Path (Join-Path $queuePath "$($command.id).cmd.json") -Value $command

        $parentCapability = [Environment]::GetEnvironmentVariable($CapabilityEnvironmentName, 'Process')
        $job = Start-Job -ScriptBlock {
            param($WorkerShell, $WorkerPath, $ActionBase, $QueueRoot, $Session, $QueueSid, $Capability)
            $env:PCDOCTOR_WORKER_CAPABILITY_V2 = $Capability
            try {
                & $WorkerShell -NoProfile -ExecutionPolicy Bypass -File $WorkerPath `
                    -BasePath $ActionBase -QueueRoot $QueueRoot -SessionId $Session `
                    -QueueUserSid $QueueSid -IdleTimeoutSeconds 1 -PollIntervalMs 20 -TestMode 2>&1
            } finally {
                Remove-Item Env:\PCDOCTOR_WORKER_CAPABILITY_V2 -ErrorAction SilentlyContinue
            }
        } -ArgumentList $ShellPath, $worker, $basePath, $queueRootPath, $FixtureSession, $queueSid, $FixtureCapability

        $heartbeatPath = Join-Path $queuePath '.heartbeat'
        $resultPath = Join-Path $queuePath "$($command.id).result.json"
        $issuedTimes = New-Object Collections.Generic.List[int64]
        $heartbeatNonces = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        $sawHeartbeat = $false
        $deadline = [DateTime]::UtcNow.AddSeconds(5)
        while (-not (Test-Path -LiteralPath $resultPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
            if (Test-Path -LiteralPath $heartbeatPath -PathType Leaf) {
                try {
                    $heartbeatText = Read-AtomicArtifactText -Path $heartbeatPath
                    if ($null -eq $heartbeatText) { continue }
                    $heartbeat = $heartbeatText | ConvertFrom-Json
                    Assert-SignedHeartbeat -Heartbeat $heartbeat
                    $sawHeartbeat = $true
                    $issuedTimes.Add([int64]$heartbeat.issued_at)
                    [void]$heartbeatNonces.Add("$($heartbeat.nonce)")
                } catch {
                    if ($sawHeartbeat) {
                        throw "Atomic heartbeat reader observed a partial artifact: $($_.Exception.Message)"
                    }
                }
            }
            Start-Sleep -Milliseconds 2
        }
        if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
            throw 'Delayed safe action did not publish a result'
        }
        if (-not $sawHeartbeat -or $heartbeatNonces.Count -lt 3 -or
            (($issuedTimes | Measure-Object -Maximum).Maximum - ($issuedTimes | Measure-Object -Minimum).Minimum) -lt 500) {
            $minimumIssued = ($issuedTimes | Measure-Object -Minimum).Minimum
            $maximumIssued = ($issuedTimes | Measure-Object -Maximum).Maximum
            throw "Heartbeat did not remain fresh while the synchronous action host was busy " +
                "(seen=$sawHeartbeat nonces=$($heartbeatNonces.Count) issued=$minimumIssued..$maximumIssued)"
        }

        $result = Read-WorkerArtifactJson -Path $resultPath
        Assert-SignedResult -Result $result -Id $command.id
        if ($result.success -ne $true -or "$($result.data.echo)" -cne 'trusted-boundary') {
            throw "Safe action-host result was invalid: $($result | ConvertTo-Json -Compress -Depth 8)"
        }

        $trustedSystem = [Environment]::SystemDirectory
        $trustedWindows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
        $trustedHost = Join-Path $trustedSystem 'WindowsPowerShell\v1.0\powershell.exe'
        $trustedPath = @(
            $trustedSystem,
            $trustedWindows,
            (Join-Path $trustedSystem 'Wbem'),
            (Join-Path $trustedSystem 'WindowsPowerShell\v1.0')
        ) -join ';'
        $trustedModules = Join-Path $trustedSystem 'WindowsPowerShell\v1.0\Modules'
        if (-not [IO.Path]::GetFullPath("$($result.data.host_path)").Equals(
                [IO.Path]::GetFullPath($trustedHost), [StringComparison]::OrdinalIgnoreCase) -or
            "$($result.data.path)" -cne $trustedPath -or
            "$($result.data.pathext)" -cne '.COM;.EXE;.BAT;.CMD' -or
            -not "$($result.data.psmodulepath)".Equals($trustedModules, [StringComparison]::OrdinalIgnoreCase) -or
            "$($result.data.system_root)" -cne $trustedWindows -or
            "$($result.data.windir)" -cne $trustedWindows -or
            "$($result.data.comspec)" -cne (Join-Path $trustedSystem 'cmd.exe')) {
            throw "Action child did not receive the trusted executable and sanitized search environment: " +
                ($result.data | ConvertTo-Json -Compress -Depth 4)
        }

        $completed = Wait-Job -Job $job -Timeout 4
        if (-not $completed) { throw 'Delayed safe action worker did not honor its idle timeout' }
        $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
        if ($output) { throw "Delayed safe action worker emitted output: $($output -join ' ')" }
        if ([Environment]::GetEnvironmentVariable($CapabilityEnvironmentName, 'Process') -ne $parentCapability) {
            throw 'Delayed action smoke mutated the parent capability environment variable'
        }
        $heartbeatTemps = @(Get-ChildItem -LiteralPath $queuePath -Filter '.heartbeat.*.tmp' -File -ErrorAction SilentlyContinue)
        if ($heartbeatTemps.Count -ne 0) { throw 'Atomic heartbeat publication left a temporary file' }
        $heartbeatBackups = @(Get-ChildItem -LiteralPath $queuePath -Filter '.heartbeat.*.bak' -File -ErrorAction SilentlyContinue)
        if ($heartbeatBackups.Count -ne 0) { throw 'Atomic heartbeat publication left a backup file' }
        Write-Host "[PASS] ${ShellName}: trusted action host and fresh atomic heartbeat"
    } finally {
        if ($job) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $queueRootPath) {
            Remove-Item -LiteralPath $queueRootPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-RejectedCommandsDoNotRefreshIdle {
    param(
        [Parameter(Mandatory=$true)][string]$ShellPath,
        [Parameter(Mandatory=$true)][string]$ShellName
    )
    $queueRootPath = Join-Path $env:TEMP "pcdoctor-worker-idle-smoke-$([guid]::NewGuid().ToString('N'))"
    $queuePath = Join-Path $queueRootPath $FixtureSession
    $job = $null
    try {
        $queueSid = New-SecureTestQueue -Path $queuePath
        $basePath = Join-Path $queuePath 'test-base'
        New-Item -ItemType Directory -Path $basePath | Out-Null
        New-TestActionFixture -BasePath $basePath

        $seedNonce = 'aa000000000000000000000000000001'
        $seed = New-SignedEnvelope -Id 'aa000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'idle-seed' }) -Nonce $seedNonce
        Write-TestJson -Path (Join-Path $queuePath "$($seed.id).cmd.json") -Value $seed

        $job = Start-Job -ScriptBlock {
            param($WorkerShell, $WorkerPath, $ActionBase, $QueueRoot, $Session, $QueueSid, $Capability, $Now)
            $env:PCDOCTOR_WORKER_CAPABILITY_V2 = $Capability
            try {
                & $WorkerShell -NoProfile -ExecutionPolicy Bypass -File $WorkerPath `
                    -BasePath $ActionBase -QueueRoot $QueueRoot -SessionId $Session `
                    -QueueUserSid $QueueSid -IdleTimeoutSeconds 1 -PollIntervalMs 20 `
                    -TestMode -TestNowMilliseconds $Now 2>&1
            } finally {
                Remove-Item Env:\PCDOCTOR_WORKER_CAPABILITY_V2 -ErrorAction SilentlyContinue
            }
        } -ArgumentList $ShellPath, $worker, $basePath, $queueRootPath, $FixtureSession, $queueSid, `
            $FixtureCapability, $FixtureNow

        $seedResultPath = Join-Path $queuePath "$($seed.id).result.json"
        $seedDeadline = [DateTime]::UtcNow.AddSeconds(5)
        while (-not (Test-Path -LiteralPath $seedResultPath -PathType Leaf) -and
            [DateTime]::UtcNow -lt $seedDeadline) { Start-Sleep -Milliseconds 20 }
        if (-not (Test-Path -LiteralPath $seedResultPath -PathType Leaf)) {
            throw 'Idle test seed command was not accepted'
        }

        $firstIds = $null
        $batch = 0
        # A 200 ms cadence is well inside the one-second idle window, so the old
        # rejection-refresh bug remains alive indefinitely. It also leaves enough
        # time for each finite queue snapshot to finish before the idle check.
        $idleDeadline = [DateTime]::UtcNow.AddMilliseconds(2500)
        while ($job.State -notin @('Completed', 'Failed', 'Stopped') -and [DateTime]::UtcNow -lt $idleDeadline) {
            $suffix = $batch.ToString('x8')
            $badHmacId = 'b' + ('0' * 23) + $suffix
            $wrongSessionId = 'c' + ('0' * 23) + $suffix
            $replayId = 'd' + ('0' * 23) + $suffix
            $malformedId = 'e' + ('0' * 23) + $suffix
            if ($null -eq $firstIds) {
                $firstIds = [ordered]@{
                    bad_hmac = $badHmacId
                    wrong_session = $wrongSessionId
                    replay = $replayId
                    malformed = $malformedId
                }
            }

            $badHmac = New-SignedEnvelope -Id $badHmacId -Action 'test-echo' `
                -Params ([ordered]@{ value = 'idle-bad-hmac' }) `
                -Nonce ('b1' + ('0' * 22) + $suffix)
            $badHmac['hmac_sha256'] = '0' * 64
            Write-TestJson -Path (Join-Path $queuePath "$badHmacId.cmd.json") -Value $badHmac

            $wrongSession = New-SignedEnvelope -Id $wrongSessionId -Action 'test-echo' `
                -Params ([ordered]@{ value = 'idle-wrong-session' }) `
                -Nonce ('c1' + ('0' * 22) + $suffix) -SessionId ('f' * 32)
            Write-TestJson -Path (Join-Path $queuePath "$wrongSessionId.cmd.json") -Value $wrongSession

            $replay = New-SignedEnvelope -Id $replayId -Action 'test-echo' `
                -Params ([ordered]@{ value = 'idle-replay' }) -Nonce $seedNonce
            Write-TestJson -Path (Join-Path $queuePath "$replayId.cmd.json") -Value $replay
            Write-TestJson -Path (Join-Path $queuePath "$malformedId.cmd.json") -Value '{not-json'

            $batch++
            Start-Sleep -Milliseconds 200
        }

        if ($job.State -notin @('Completed', 'Failed', 'Stopped')) {
            throw 'Rejected command traffic extended the worker idle lifetime'
        }
        if ($job.State -ne 'Completed') { throw "Idle worker ended in unexpected state: $($job.State)" }
        $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
        if ($output) { throw "Idle worker emitted output: $($output -join ' ')" }

        Assert-ResultCode -QueueDir $queuePath -Id $firstIds.bad_hmac -Code 'E_BAD_HMAC'
        Assert-ResultCode -QueueDir $queuePath -Id $firstIds.wrong_session -Code 'E_WRONG_SESSION'
        Assert-ResultCode -QueueDir $queuePath -Id $firstIds.replay -Code 'E_REPLAY'
        Assert-ResultCode -QueueDir $queuePath -Id $firstIds.malformed -Code 'E_BAD_CMD'
        Write-Host "[PASS] ${ShellName}: rejected traffic did not refresh idle activity"
    } finally {
        if ($job) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $queueRootPath) {
            Remove-Item -LiteralPath $queueRootPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-RejectedBacklogHonorsIdleDeadline {
    param(
        [Parameter(Mandatory=$true)][string]$ShellPath,
        [Parameter(Mandatory=$true)][string]$ShellName
    )
    $queueRootPath = Join-Path $env:TEMP "pcdoctor-worker-backlog-smoke-$([guid]::NewGuid().ToString('N'))"
    $queuePath = Join-Path $queueRootPath $FixtureSession
    $job = $null
    try {
        $queueSid = New-SecureTestQueue -Path $queuePath
        $basePath = Join-Path $queuePath 'test-base'
        New-Item -ItemType Directory -Path $basePath | Out-Null
        New-TestActionFixture -BasePath $basePath

        $seed = New-SignedEnvelope -Id '01000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'backlog-seed' }) `
            -Nonce '01000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $queuePath "$($seed.id).cmd.json") -Value $seed
        for ($index = 0; $index -lt 2500; $index++) {
            $id = 'f' + $index.ToString('x31')
            Write-TestJson -Path (Join-Path $queuePath "$id.cmd.json") -Value '{not-json'
        }

        $job = Start-Job -ScriptBlock {
            param($WorkerShell, $WorkerPath, $ActionBase, $QueueRoot, $Session, $QueueSid, $Capability, $Now)
            $env:PCDOCTOR_WORKER_CAPABILITY_V2 = $Capability
            try {
                & $WorkerShell -NoProfile -ExecutionPolicy Bypass -File $WorkerPath `
                    -BasePath $ActionBase -QueueRoot $QueueRoot -SessionId $Session `
                    -QueueUserSid $QueueSid -IdleTimeoutSeconds 1 -PollIntervalMs 20 `
                    -TestMode -TestNowMilliseconds $Now 2>&1
            } finally {
                Remove-Item Env:\PCDOCTOR_WORKER_CAPABILITY_V2 -ErrorAction SilentlyContinue
            }
        } -ArgumentList $ShellPath, $worker, $basePath, $queueRootPath, $FixtureSession, $queueSid, `
            $FixtureCapability, $FixtureNow

        $seedResultPath = Join-Path $queuePath "$($seed.id).result.json"
        $seedDeadline = [DateTime]::UtcNow.AddSeconds(8)
        while (-not (Test-Path -LiteralPath $seedResultPath -PathType Leaf) -and
            [DateTime]::UtcNow -lt $seedDeadline) { Start-Sleep -Milliseconds 20 }
        if (-not (Test-Path -LiteralPath $seedResultPath -PathType Leaf)) {
            throw 'Backlog test seed command was not accepted'
        }
        $seedResult = Read-WorkerArtifactJson -Path $seedResultPath
        Assert-SignedResult -Result $seedResult -Id $seed.id
        if ($seedResult.success -ne $true -or "$($seedResult.data.echo)" -cne 'backlog-seed') {
            throw 'Backlog test seed command did not complete successfully'
        }

        $completed = Wait-Job -Job $job -Timeout 4
        if (-not $completed) { throw 'Unauthenticated backlog extended the worker past its idle deadline' }
        $output = Receive-Job -Job $job -ErrorAction SilentlyContinue
        if ($output) { throw "Backlog worker emitted output: $($output -join ' ')" }
        $remaining = @(Get-ChildItem -LiteralPath $queuePath -Filter '*.cmd.json' -File)
        if ($remaining.Count -eq 0) {
            throw 'Worker drained the entire unauthenticated snapshot before enforcing its idle deadline'
        }
        Write-Host "[PASS] ${ShellName}: rejected backlog could not defer the idle deadline"
    } finally {
        if ($job) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $queueRootPath) {
            Remove-Item -LiteralPath $queueRootPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

function Assert-ResultCode {
    param(
        [Parameter(Mandatory=$true)][string]$QueueDir,
        [Parameter(Mandatory=$true)][string]$Id,
        [Parameter(Mandatory=$true)][string]$Code
    )
    $resultPath = Join-Path $QueueDir "$Id.result.json"
    if (-not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
        throw "Missing result for $Id"
    }
    $result = Read-WorkerArtifactJson -Path $resultPath
    Assert-SignedResult -Result $result -Id $Id
    if ($result.success -ne $false -or "$($result.error.code)" -ne $Code) {
        throw "Expected $Id to return $Code, got: $($result | ConvertTo-Json -Compress -Depth 8)"
    }
}

if ((Get-TestHmac -Canonical $FixtureCanonical) -ne $FixtureHmac) {
    Write-Host '[FAIL] Independent literal HMAC fixture is internally inconsistent'
    exit 1
}
if ((Get-TestHmac -Canonical $NonAsciiFixtureCanonical) -ne $NonAsciiFixtureHmac) {
    Write-Host '[FAIL] Independent non-ASCII HMAC fixture is internally inconsistent'
    exit 1
}

try {
    Assert-WorkerArgumentMaps
    Assert-WorkerPureHelpers
    Assert-WorkerQueueAclModel
    Assert-WorkerSourceSafety
    Assert-ServiceStartupPureHelpers
}
catch {
    Write-Host "[FAIL] $($_.Exception.Message)"
    exit 1
}

$pwsh7 = 'C:\Program Files\PowerShell\7\pwsh.exe'
$ps51 = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$shells = @()
if (Test-Path -LiteralPath $pwsh7 -PathType Leaf) { $shells += @{ Path = $pwsh7; Name = 'pwsh 7' } }
if (Test-Path -LiteralPath $ps51 -PathType Leaf) { $shells += @{ Path = $ps51; Name = 'PS 5.1' } }
if ($shells.Count -eq 0) {
    Write-Host '[FAIL] Neither pwsh 7 nor PS 5.1 found'
    exit 1
}

$failed = 0
foreach ($shell in $shells) {
    $queueRoot = Join-Path $env:TEMP "pcdoctor-worker-auth-smoke-$([guid]::NewGuid().ToString('N'))"
    $resolvedTemp = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
    $resolvedQueueRoot = [IO.Path]::GetFullPath($queueRoot)
    $resolvedQueue = Join-Path $resolvedQueueRoot $FixtureSession
    if (-not $resolvedQueueRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase)) {
        Write-Host "[FAIL] Refusing non-temp queue root: $resolvedQueueRoot"
        exit 1
    }

    try {
        $queueUserSid = New-SecureTestQueue -Path $resolvedQueue
        $emptyBase = Join-Path $resolvedQueue 'empty-base'
        New-Item -ItemType Directory -Path $emptyBase | Out-Null
        New-TestActionFixture -BasePath $emptyBase

        # Literal cross-language fixture. TestMode validates it fully, then returns
        # E_TEST_MODE_NO_EXECUTION instead of invoking Set-ServiceStartup.ps1.
        $fixtureEnvelope = [ordered]@{
            version = 2; session_id = $FixtureSession
            id = 'ffeeddccbbaa99887766554433221100'; action = 'set-service-startup'
            params = [ordered]@{ startup_type = 'Disabled'; service = 'Spooler' }
            issued_at = [int64]1770000000000; expires_at = [int64]1770000025000
            nonce = '0123456789abcdeffedcba9876543210'; hmac_sha256 = $FixtureHmac
        }
        Write-TestJson -Path (Join-Path $resolvedQueue "$($fixtureEnvelope.id).cmd.json") -Value $fixtureEnvelope

        $safeMaxService = New-SignedEnvelope -Id 'f1000000000000000000000000000000' -Action 'stop-service' `
            -Params ([ordered]@{ service = ('A' * 128) }) -Nonce 'f1000000000000000000000000000001'
        $safeKillTarget = New-SignedEnvelope -Id 'f2000000000000000000000000000000' -Action 'kill-process' `
            -Params ([ordered]@{ target = 'aZ09._-' }) -Nonce 'f2000000000000000000000000000001'
        $unsafeServiceWildcard = New-SignedEnvelope -Id 'f3000000000000000000000000000000' -Action 'stop-service' `
            -Params ([ordered]@{ service = '*' }) -Nonce 'f3000000000000000000000000000001'
        $unsafeServicePath = New-SignedEnvelope -Id 'f4000000000000000000000000000000' -Action 'start-service' `
            -Params ([ordered]@{ service = 'bad/name' }) -Nonce 'f4000000000000000000000000000001'
        $unsafeServiceLength = New-SignedEnvelope -Id 'f5000000000000000000000000000000' -Action 'restart-service' `
            -Params ([ordered]@{ service = ('A' * 129) }) -Nonce 'f5000000000000000000000000000001'
        $unsafeKillTarget = New-SignedEnvelope -Id 'f6000000000000000000000000000000' -Action 'kill-process' `
            -Params ([ordered]@{ target = 'bad target' }) -Nonce 'f6000000000000000000000000000001'
        foreach ($safeNameEnvelope in @(
            $safeMaxService, $safeKillTarget, $unsafeServiceWildcard, $unsafeServicePath,
            $unsafeServiceLength, $unsafeKillTarget
        )) {
            Write-TestJson -Path (Join-Path $resolvedQueue "$($safeNameEnvelope.id).cmd.json") -Value $safeNameEnvelope
        }

        $valid = New-SignedEnvelope -Id '10000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'safe-smoke' }) -Nonce '10000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($valid.id).cmd.json") -Value $valid

        # The expected digest was derived independently in Node from the literal
        # canonical UTF-8 bytes. Writing this value raw catches TS/PS Unicode drift.
        $nonAscii = [ordered]@{
            version = 2; session_id = $FixtureSession
            id = 'e0000000000000000000000000000000'; action = 'test-echo'
            params = [ordered]@{ value = $NonAsciiValue }
            issued_at = [int64]1770000000000; expires_at = [int64]1770000021000
            nonce = 'e0000000000000000000000000000001'; hmac_sha256 = $NonAsciiFixtureHmac
        }
        Write-TestJson -Path (Join-Path $resolvedQueue "$($nonAscii.id).cmd.json") -Value $nonAscii

        $badHmac = New-SignedEnvelope -Id '20000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'bad-hmac' }) -Nonce '20000000000000000000000000000001'
        $badHmac.hmac_sha256 = '0' * 64
        Write-TestJson -Path (Join-Path $resolvedQueue "$($badHmac.id).cmd.json") -Value $badHmac

        $wrongSession = New-SignedEnvelope -Id '30000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'wrong-session' }) -Nonce '30000000000000000000000000000001' `
            -SessionId 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($wrongSession.id).cmd.json") -Value $wrongSession

        $expired = New-SignedEnvelope -Id '40000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'expired' }) -Nonce '40000000000000000000000000000001' `
            -IssuedAt ($FixtureNow - 1000) -ExpiresAt $FixtureNow
        Write-TestJson -Path (Join-Path $resolvedQueue "$($expired.id).cmd.json") -Value $expired

        $future = New-SignedEnvelope -Id '50000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'future' }) -Nonce '50000000000000000000000000000001' `
            -IssuedAt ($FixtureNow + 5001) -ExpiresAt ($FixtureNow + 20000)
        Write-TestJson -Path (Join-Path $resolvedQueue "$($future.id).cmd.json") -Value $future

        $longLifetime = New-SignedEnvelope -Id '60000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'long' }) -Nonce '60000000000000000000000000000001' `
            -IssuedAt $FixtureNow -ExpiresAt ($FixtureNow + 30001)
        Write-TestJson -Path (Join-Path $resolvedQueue "$($longLifetime.id).cmd.json") -Value $longLifetime

        $extra = New-SignedEnvelope -Id '70000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'extra' }) -Nonce '70000000000000000000000000000001'
        $extra['extra'] = 'forbidden'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($extra.id).cmd.json") -Value $extra

        $badParams = New-SignedEnvelope -Id '80000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ path = 'C:\Windows\System32\cmd.exe'; value = 'bad-params' }) `
            -Nonce '80000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($badParams.id).cmd.json") -Value $badParams

        $reboot = New-SignedEnvelope -Id '90000000000000000000000000000000' -Action 'reboot' `
            -Params ([ordered]@{}) -Nonce '90000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($reboot.id).cmd.json") -Value $reboot

        $automatic = New-SignedEnvelope -Id '91000000000000000000000000000000' `
            -Action 'set-service-startup' `
            -Params ([ordered]@{ service = 'Spooler'; startup_type = 'Disabled' }) `
            -Nonce '91000000000000000000000000000001' `
            -PolicyId 'forged-policy' -IntentId 'forged-intent'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($automatic.id).cmd.json") -Value $automatic

        $policyOnly = New-SignedEnvelope -Id '92000000000000000000000000000000' `
            -Action 'set-service-startup' `
            -Params ([ordered]@{ service = 'Spooler'; startup_type = 'Disabled' }) `
            -Nonce '92000000000000000000000000000001' -PolicyId 'forged-policy'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($policyOnly.id).cmd.json") -Value $policyOnly

        $replayNonce = 'a0000000000000000000000000000001'
        $replayOne = New-SignedEnvelope -Id 'a0000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'replay-one' }) -Nonce $replayNonce
        $replayTwo = New-SignedEnvelope -Id 'a1000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'replay-two' }) -Nonce $replayNonce
        Write-TestJson -Path (Join-Path $resolvedQueue "$($replayOne.id).cmd.json") -Value $replayOne
        Write-TestJson -Path (Join-Path $resolvedQueue "$($replayTwo.id).cmd.json") -Value $replayTwo

        $upperAction = New-SignedEnvelope -Id 'd0000000000000000000000000000000' -Action 'STOP-SERVICE' `
            -Params ([ordered]@{ service = 'Spooler' }) -Nonce 'd0000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($upperAction.id).cmd.json") -Value $upperAction

        $wrongCaseEnum = New-SignedEnvelope -Id 'd1000000000000000000000000000000' `
            -Action 'set-service-startup' `
            -Params ([ordered]@{ service = 'Spooler'; startup_type = 'disabled' }) `
            -Nonce 'd1000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($wrongCaseEnum.id).cmd.json") -Value $wrongCaseEnum

        $upperNonce = New-SignedEnvelope -Id 'd2000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'upper-nonce' }) -Nonce ('D' * 32)
        Write-TestJson -Path (Join-Path $resolvedQueue "$($upperNonce.id).cmd.json") -Value $upperNonce

        $upperSession = New-SignedEnvelope -Id 'd3000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'upper-session' }) -Nonce 'd3000000000000000000000000000001' `
            -SessionId $FixtureSession.ToUpperInvariant()
        Write-TestJson -Path (Join-Path $resolvedQueue "$($upperSession.id).cmd.json") -Value $upperSession

        $wrongCaseParam = New-SignedEnvelope -Id 'd4000000000000000000000000000000' -Action 'stop-service' `
            -Params ([ordered]@{ DRY_RUN = $true; service = 'Spooler' }) `
            -Nonce 'd4000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$($wrongCaseParam.id).cmd.json") -Value $wrongCaseParam

        $upperHmac = New-SignedEnvelope -Id 'd5000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'upper-hmac' }) -Nonce 'd5000000000000000000000000000001'
        $upperHmac['hmac_sha256'] = $upperHmac['hmac_sha256'].ToUpperInvariant()
        Write-TestJson -Path (Join-Path $resolvedQueue "$($upperHmac.id).cmd.json") -Value $upperHmac

        $hmacTrailingLf = New-SignedEnvelope -Id 'd6000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'hmac-trailing-lf' }) -Nonce 'd6000000000000000000000000000001'
        $hmacTrailingLf['hmac_sha256'] = $hmacTrailingLf['hmac_sha256'] + "`n"
        Write-TestJson -Path (Join-Path $resolvedQueue "$($hmacTrailingLf.id).cmd.json") -Value $hmacTrailingLf

        $nonceTrailingLf = New-SignedEnvelope -Id 'd7000000000000000000000000000000' -Action 'test-echo' `
            -Params ([ordered]@{ value = 'nonce-trailing-lf' }) -Nonce (('a' * 32) + "`n")
        Write-TestJson -Path (Join-Path $resolvedQueue "$($nonceTrailingLf.id).cmd.json") -Value $nonceTrailingLf

        $malformedId = 'b0000000000000000000000000000000'
        Write-TestJson -Path (Join-Path $resolvedQueue "$malformedId.cmd.json") -Value '{not-json'

        $atomicId = 'c0000000000000000000000000000000'
        $atomic = New-SignedEnvelope -Id $atomicId -Action 'test-echo' `
            -Params ([ordered]@{ value = 'atomic-failure' }) -Nonce 'c0000000000000000000000000000001'
        Write-TestJson -Path (Join-Path $resolvedQueue "$atomicId.cmd.json") -Value $atomic
        New-Item -ItemType Directory -Path (Join-Path $resolvedQueue "$atomicId.result.json") | Out-Null

        $parentCapability = [Environment]::GetEnvironmentVariable($CapabilityEnvironmentName, 'Process')
        $job = Start-Job -ScriptBlock {
            param($ShellPath, $WorkerPath, $BasePath, $QueueRoot, $SessionId, $QueueSid, $Capability, $Now)
            $env:PCDOCTOR_WORKER_CAPABILITY_V2 = $Capability
            try {
                & $ShellPath -NoProfile -ExecutionPolicy Bypass -File $WorkerPath `
                    -BasePath $BasePath -QueueRoot $QueueRoot -SessionId $SessionId `
                    -QueueUserSid $QueueSid -IdleTimeoutSeconds 3 -PollIntervalMs 20 `
                    -TestMode -TestNowMilliseconds $Now 2>&1
            } finally {
                Remove-Item Env:\PCDOCTOR_WORKER_CAPABILITY_V2 -ErrorAction SilentlyContinue
            }
        } -ArgumentList $shell.Path, $worker, $emptyBase, $resolvedQueueRoot, $FixtureSession, `
            $queueUserSid, $FixtureCapability, $FixtureNow

        $heartbeat = $null
        $heartbeatFailure = 'heartbeat did not appear'
        for ($attempt = 0; $attempt -lt 150 -and -not $heartbeat; $attempt++) {
            try {
                $candidatePath = Join-Path $resolvedQueue '.heartbeat'
                if (Test-Path -LiteralPath $candidatePath -PathType Leaf) {
                    $candidate = Read-WorkerArtifactJson -Path $candidatePath
                    Assert-SignedHeartbeat -Heartbeat $candidate
                    $heartbeat = $candidate
                }
            } catch {
                $heartbeatFailure = $_.Exception.Message
            }
            if (-not $heartbeat) { Start-Sleep -Milliseconds 20 }
        }
        if (-not $heartbeat) { throw "Authenticated heartbeat unavailable: $heartbeatFailure" }

        $completed = Wait-Job -Job $job -Timeout 20
        if (-not $completed) {
            Stop-Job -Job $job -ErrorAction SilentlyContinue
            throw 'Worker did not exit within the safe smoke timeout'
        }
        $jobOutput = Receive-Job -Job $job -ErrorAction SilentlyContinue
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        if ($jobOutput) {
            throw "Worker emitted unexpected output: $($jobOutput -join ' ')"
        }
        if ([Environment]::GetEnvironmentVariable($CapabilityEnvironmentName, 'Process') -ne $parentCapability) {
            throw 'Smoke mutated the parent capability environment variable'
        }

        Assert-ResultCode -QueueDir $resolvedQueue -Id $fixtureEnvelope.id -Code 'E_TEST_MODE_NO_EXECUTION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $safeMaxService.id -Code 'E_TEST_MODE_NO_EXECUTION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $safeKillTarget.id -Code 'E_TEST_MODE_NO_EXECUTION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $unsafeServiceWildcard.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $unsafeServicePath.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $unsafeServiceLength.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $unsafeKillTarget.id -Code 'E_INVALID_PARAMS'
        $validResult = Read-WorkerArtifactJson -Path (Join-Path $resolvedQueue "$($valid.id).result.json")
        Assert-SignedResult -Result $validResult -Id $valid.id
        if ($validResult.success -ne $true -or "$($validResult.data.echo)" -ne 'safe-smoke') {
            throw "Safe synthetic action did not return the expected result: $($validResult | ConvertTo-Json -Compress -Depth 8)"
        }
        $nonAsciiResult = Read-WorkerArtifactJson -Path (Join-Path $resolvedQueue "$($nonAscii.id).result.json")
        Assert-SignedResult -Result $nonAsciiResult -Id $nonAscii.id
        if ($nonAsciiResult.success -ne $true -or "$($nonAsciiResult.data.echo)" -cne $NonAsciiValue) {
            throw "Raw non-ASCII command did not round-trip through authenticated worker output: $($nonAsciiResult | ConvertTo-Json -Compress -Depth 8)"
        }
        Assert-ResultCode -QueueDir $resolvedQueue -Id $badHmac.id -Code 'E_BAD_HMAC'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $wrongSession.id -Code 'E_WRONG_SESSION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $expired.id -Code 'E_ENVELOPE_EXPIRED'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $future.id -Code 'E_ENVELOPE_FUTURE'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $longLifetime.id -Code 'E_ENVELOPE_LIFETIME'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $extra.id -Code 'E_BAD_ENVELOPE'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $badParams.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $reboot.id -Code 'E_REBOOT_FORBIDDEN'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $automatic.id -Code 'E_AUTOMATION_NEVER'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $policyOnly.id -Code 'E_AUTOMATIC_CAPABILITY_REQUIRED'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $malformedId -Code 'E_BAD_CMD'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $upperAction.id -Code 'E_INVALID_ACTION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $wrongCaseEnum.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $upperNonce.id -Code 'E_BAD_ENVELOPE'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $upperSession.id -Code 'E_WRONG_SESSION'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $wrongCaseParam.id -Code 'E_INVALID_PARAMS'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $upperHmac.id -Code 'E_BAD_ENVELOPE'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $hmacTrailingLf.id -Code 'E_BAD_ENVELOPE'
        Assert-ResultCode -QueueDir $resolvedQueue -Id $nonceTrailingLf.id -Code 'E_BAD_ENVELOPE'

        $replayResults = @(
            (Read-WorkerArtifactJson -Path (Join-Path $resolvedQueue "$($replayOne.id).result.json")),
            (Read-WorkerArtifactJson -Path (Join-Path $resolvedQueue "$($replayTwo.id).result.json"))
        )
        Assert-SignedResult -Result $replayResults[0] -Id $replayOne.id
        Assert-SignedResult -Result $replayResults[1] -Id $replayTwo.id
        if (@($replayResults | Where-Object { $_.success -eq $true }).Count -ne 1 -or
            @($replayResults | Where-Object { $_.error.code -eq 'E_REPLAY' }).Count -ne 1) {
            throw 'Replay pair did not produce exactly one success and one E_REPLAY'
        }

        $atomicPath = Join-Path $resolvedQueue "$atomicId.result.json"
        if (Test-Path -LiteralPath $atomicPath -PathType Leaf) {
            throw 'Atomic rename failure exposed a partially trusted result file'
        }
        $tempResults = @(Get-ChildItem -LiteralPath $resolvedQueue -Filter '*.result.*.tmp' -File -ErrorAction SilentlyContinue)
        if ($tempResults.Count -ne 0) {
            throw 'Atomic rename failure left a temporary result file'
        }

        Write-Host "[PASS] $($shell.Name): authenticated temp-only worker smoke"
        Assert-TrustedActionHostAndFreshHeartbeat -ShellPath $shell.Path -ShellName $shell.Name
        Assert-RejectedCommandsDoNotRefreshIdle -ShellPath $shell.Path -ShellName $shell.Name
        Assert-RejectedBacklogHonorsIdleDeadline -ShellPath $shell.Path -ShellName $shell.Name
    } catch {
        Write-Host "[FAIL] $($shell.Name): $($_.Exception.Message)"
        $failed++
    } finally {
        if (Test-Path -LiteralPath $resolvedQueueRoot) {
            Remove-Item -LiteralPath $resolvedQueueRoot -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

[Array]::Clear($FixtureCapabilityBytes, 0, $FixtureCapabilityBytes.Length)
if ($failed -eq 0) {
    Write-Host '[PASS] Worker smoke stayed non-elevated and temp-only on all shells'
    exit 0
}

Write-Host "[FAIL] $failed shell(s) failed the authenticated worker smoke"
exit 1
