<#
.SYNOPSIS
    Authenticated elevated worker for PCDoctor command envelopes V2.

.DESCRIPTION
    Polls one session-specific queue, independently validates exact JSON shape,
    session, time, HMAC, replay, action policy, and params, then invokes only a
    fixed script and argument map. Result files become visible through an atomic
    same-directory rename.

    -TestMode is non-elevated smoke isolation. It requires queue and BasePath under
    TEMP, never invokes maintenance scripts, and can execute only the fixed
    test-echo fixture beneath that temporary BasePath.

.NOTES
    PowerShell 5.1 compatible. The memory-only capability is read once from the
    dedicated process environment variable and that variable is cleared immediately.
#>
param(
    [Parameter(Mandatory=$true)]
    [string]$BasePath,

    [Parameter(Mandatory=$true)]
    [string]$QueueRoot,

    [Parameter(Mandatory=$true)]
    [string]$SessionId,

    [Parameter(Mandatory=$true)]
    [string]$QueueUserSid,

    [int]$IdleTimeoutSeconds = 600,

    [int]$PollIntervalMs = 100,

    [switch]$TestMode,

    [int64]$TestNowMilliseconds = -1
)

$ErrorActionPreference = 'Stop'
$CapabilityEnvironmentName = 'PCDOCTOR_WORKER_CAPABILITY_V2'
$MaxCommandBytes = 1048576
$MaxCommandFilesPerIteration = 64
$script:ProductionQueueRoot = 'C:\ProgramData\PCDoctorWorkerQueue'
$QueueDir = $null
$script:CapabilityBytes = $null
$script:TrustedPowerShellPath = $null
$capabilityText = [Environment]::GetEnvironmentVariable($CapabilityEnvironmentName, 'Process')
[Environment]::SetEnvironmentVariable($CapabilityEnvironmentName, $null, 'Process')

function Throw-WorkerError {
    param(
        [Parameter(Mandatory=$true)][string]$Code,
        [Parameter(Mandatory=$true)][string]$Message
    )
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['code'] = $Code
    throw $exception
}

function Test-SafeInteger {
    param($Value)
    return $Value -is [int64] -and
        $Value -ge -9007199254740991 -and
        $Value -le 9007199254740991
}

function Read-BoundedUtf8File {
    param(
        [Parameter(Mandatory=$true)][string]$Path,
        [Parameter(Mandatory=$true)][int64]$MaxBytes
    )
    if ($MaxBytes -lt 0 -or $MaxBytes -gt [int]::MaxValue) {
        Throw-WorkerError 'E_BAD_CMD' 'Command size limit is invalid'
    }
    $stream = $null
    $bytes = $null
    try {
        # FileShare.Read prevents a same-user writer from growing or replacing the
        # command between the bounded length check and the final byte read.
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($stream.Length -gt $MaxBytes) { Throw-WorkerError 'E_BAD_CMD' 'Command exceeds the size limit' }
        $length = [int]$stream.Length
        $bytes = New-Object byte[] $length
        $offset = 0
        while ($offset -lt $length) {
            $count = $stream.Read($bytes, $offset, $length - $offset)
            if ($count -le 0) { Throw-WorkerError 'E_BAD_CMD' 'Command file ended during read' }
            $offset += $count
        }
        return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes)
    } finally {
        if ($stream) { $stream.Dispose() }
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
    }
}

# ---------------------------------------------------------------------------
# Strict JSON parser
# ---------------------------------------------------------------------------

function Skip-StrictJsonWhitespace {
    while ($script:StrictJsonIndex -lt $script:StrictJsonText.Length) {
        $unit = [int][char]$script:StrictJsonText[$script:StrictJsonIndex]
        if ($unit -ne 0x20 -and $unit -ne 0x09 -and $unit -ne 0x0A -and $unit -ne 0x0D) { break }
        $script:StrictJsonIndex++
    }
}

function Read-StrictJsonHexUnit {
    if ($script:StrictJsonIndex + 4 -gt $script:StrictJsonText.Length) {
        throw 'Incomplete JSON Unicode escape'
    }
    $hex = $script:StrictJsonText.Substring($script:StrictJsonIndex, 4)
    if ($hex -notmatch '^[0-9a-fA-F]{4}\z') { throw 'Invalid JSON Unicode escape' }
    $script:StrictJsonIndex += 4
    return [Convert]::ToInt32($hex, 16)
}

function Read-StrictJsonString {
    if ($script:StrictJsonText[$script:StrictJsonIndex] -ne '"') { throw 'Expected JSON string' }
    $script:StrictJsonIndex++
    $builder = New-Object Text.StringBuilder
    while ($script:StrictJsonIndex -lt $script:StrictJsonText.Length) {
        $character = $script:StrictJsonText[$script:StrictJsonIndex]
        $script:StrictJsonIndex++
        if ($character -eq '"') { return $builder.ToString() }
        $unit = [int][char]$character
        if ($unit -lt 0x20) { throw 'Unescaped JSON control character' }
        if ($character -ne '\') {
            if ($unit -ge 0xD800 -and $unit -le 0xDBFF) {
                if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) {
                    throw 'Lone high JSON surrogate'
                }
                $second = [int][char]$script:StrictJsonText[$script:StrictJsonIndex]
                if ($second -lt 0xDC00 -or $second -gt 0xDFFF) {
                    throw 'Invalid JSON surrogate pair'
                }
                [void]$builder.Append($character)
                [void]$builder.Append($script:StrictJsonText[$script:StrictJsonIndex])
                $script:StrictJsonIndex++
                continue
            }
            if ($unit -ge 0xDC00 -and $unit -le 0xDFFF) { throw 'Lone low JSON surrogate' }
            [void]$builder.Append($character)
            continue
        }

        if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) { throw 'Incomplete JSON escape' }
        $escape = $script:StrictJsonText[$script:StrictJsonIndex]
        $script:StrictJsonIndex++
        switch -CaseSensitive ($escape) {
            '"' { [void]$builder.Append('"') }
            '\' { [void]$builder.Append('\') }
            '/'  { [void]$builder.Append('/') }
            'b'  { [void]$builder.Append([char]0x08) }
            'f'  { [void]$builder.Append([char]0x0C) }
            'n'  { [void]$builder.Append([char]0x0A) }
            'r'  { [void]$builder.Append([char]0x0D) }
            't'  { [void]$builder.Append([char]0x09) }
            'u'  {
                $first = Read-StrictJsonHexUnit
                if ($first -ge 0xD800 -and $first -le 0xDBFF) {
                    if ($script:StrictJsonIndex + 6 -gt $script:StrictJsonText.Length -or
                        $script:StrictJsonText[$script:StrictJsonIndex] -ne '\' -or
                        $script:StrictJsonText[$script:StrictJsonIndex + 1] -ne 'u') {
                        throw 'Lone high JSON surrogate'
                    }
                    $script:StrictJsonIndex += 2
                    $second = Read-StrictJsonHexUnit
                    if ($second -lt 0xDC00 -or $second -gt 0xDFFF) { throw 'Invalid JSON surrogate pair' }
                    [void]$builder.Append([char]$first)
                    [void]$builder.Append([char]$second)
                } elseif ($first -ge 0xDC00 -and $first -le 0xDFFF) {
                    throw 'Lone low JSON surrogate'
                } else {
                    [void]$builder.Append([char]$first)
                }
            }
            default { throw 'Invalid JSON escape' }
        }
    }
    throw 'Unterminated JSON string'
}

function Read-StrictJsonNumber {
    $start = $script:StrictJsonIndex
    if ($script:StrictJsonText[$script:StrictJsonIndex] -eq '-') { $script:StrictJsonIndex++ }
    if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) { throw 'Incomplete JSON number' }
    $first = $script:StrictJsonText[$script:StrictJsonIndex]
    if ($first -eq '0') {
        $script:StrictJsonIndex++
        if ($script:StrictJsonIndex -lt $script:StrictJsonText.Length -and
            $script:StrictJsonText[$script:StrictJsonIndex] -match '[0-9]') {
            throw 'JSON number has a leading zero'
        }
    } elseif ($first -match '[1-9]') {
        do { $script:StrictJsonIndex++ }
        while ($script:StrictJsonIndex -lt $script:StrictJsonText.Length -and
            $script:StrictJsonText[$script:StrictJsonIndex] -match '[0-9]')
    } else {
        throw 'Invalid JSON number'
    }
    if ($script:StrictJsonIndex -lt $script:StrictJsonText.Length -and
        $script:StrictJsonText[$script:StrictJsonIndex] -match '[\.eE]') {
        throw 'Only integer JSON numbers are accepted'
    }
    $text = $script:StrictJsonText.Substring($start, $script:StrictJsonIndex - $start)
    if ($text -eq '-0') { throw 'Negative zero is not canonical' }
    try {
        $number = [int64]::Parse($text, [Globalization.CultureInfo]::InvariantCulture)
    } catch {
        throw 'JSON integer is out of range'
    }
    if (-not (Test-SafeInteger $number)) { throw 'JSON integer is not cross-language safe' }
    return $number
}

function Read-StrictJsonObject {
    $script:StrictJsonIndex++
    $object = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    Skip-StrictJsonWhitespace
    if ($script:StrictJsonIndex -lt $script:StrictJsonText.Length -and
        $script:StrictJsonText[$script:StrictJsonIndex] -eq '}') {
        $script:StrictJsonIndex++
        return $object
    }
    while ($true) {
        Skip-StrictJsonWhitespace
        $key = Read-StrictJsonString
        if ($object.ContainsKey($key)) { throw "Duplicate JSON property: $key" }
        Skip-StrictJsonWhitespace
        if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length -or
            $script:StrictJsonText[$script:StrictJsonIndex] -ne ':') { throw 'Expected JSON colon' }
        $script:StrictJsonIndex++
        $value = Read-StrictJsonValue
        $object.Add($key, $value)
        Skip-StrictJsonWhitespace
        if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) { throw 'Unterminated JSON object' }
        $separator = $script:StrictJsonText[$script:StrictJsonIndex]
        $script:StrictJsonIndex++
        if ($separator -eq '}') { return $object }
        if ($separator -ne ',') { throw 'Expected JSON object separator' }
    }
}

function Read-StrictJsonArray {
    $script:StrictJsonIndex++
    $items = New-Object Collections.ArrayList
    Skip-StrictJsonWhitespace
    if ($script:StrictJsonIndex -lt $script:StrictJsonText.Length -and
        $script:StrictJsonText[$script:StrictJsonIndex] -eq ']') {
        $script:StrictJsonIndex++
        Write-Output -NoEnumerate ([object[]]@())
        return
    }
    while ($true) {
        [void]$items.Add((Read-StrictJsonValue))
        Skip-StrictJsonWhitespace
        if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) { throw 'Unterminated JSON array' }
        $separator = $script:StrictJsonText[$script:StrictJsonIndex]
        $script:StrictJsonIndex++
        if ($separator -eq ']') {
            Write-Output -NoEnumerate ([object[]]$items.ToArray())
            return
        }
        if ($separator -ne ',') { throw 'Expected JSON array separator' }
    }
}

function Read-StrictJsonValue {
    Skip-StrictJsonWhitespace
    if ($script:StrictJsonIndex -ge $script:StrictJsonText.Length) { throw 'Missing JSON value' }
    $character = $script:StrictJsonText[$script:StrictJsonIndex]
    switch -CaseSensitive ($character) {
        '{' { return Read-StrictJsonObject }
        '[' { return Read-StrictJsonArray }
        '"' { return Read-StrictJsonString }
        't' {
            if ($script:StrictJsonText.Substring($script:StrictJsonIndex, 4) -cne 'true') { throw 'Invalid JSON literal' }
            $script:StrictJsonIndex += 4
            return $true
        }
        'f' {
            if ($script:StrictJsonText.Substring($script:StrictJsonIndex, 5) -cne 'false') { throw 'Invalid JSON literal' }
            $script:StrictJsonIndex += 5
            return $false
        }
        'n' {
            if ($script:StrictJsonText.Substring($script:StrictJsonIndex, 4) -cne 'null') { throw 'Invalid JSON literal' }
            $script:StrictJsonIndex += 4
            return $null
        }
        default {
            if ($character -eq '-' -or $character -match '[0-9]') { return Read-StrictJsonNumber }
            throw 'Invalid JSON value'
        }
    }
}

function ConvertFrom-StrictJson {
    param([Parameter(Mandatory=$true)][string]$Text)
    $script:StrictJsonText = $Text
    $script:StrictJsonIndex = 0
    try {
        $value = Read-StrictJsonValue
        Skip-StrictJsonWhitespace
        if ($script:StrictJsonIndex -ne $script:StrictJsonText.Length) { throw 'Trailing JSON content' }
        if ($value -is [Array]) {
            Write-Output -NoEnumerate $value
            return
        }
        return $value
    } finally {
        $script:StrictJsonText = $null
        $script:StrictJsonIndex = 0
    }
}

# ---------------------------------------------------------------------------
# Canonical JSON and HMAC
# ---------------------------------------------------------------------------

function ConvertTo-CanonicalJsonString {
    param([Parameter(Mandatory=$true)][string]$Value)
    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    for ($index = 0; $index -lt $Value.Length; $index++) {
        $unit = [int][char]$Value[$index]
        # `continue` inside a PowerShell switch continues the switch rather than
        # this for-loop, which would append the original character a second time.
        if ($unit -eq 0x08) { [void]$builder.Append('\b'); continue }
        if ($unit -eq 0x09) { [void]$builder.Append('\t'); continue }
        if ($unit -eq 0x0A) { [void]$builder.Append('\n'); continue }
        if ($unit -eq 0x0C) { [void]$builder.Append('\f'); continue }
        if ($unit -eq 0x0D) { [void]$builder.Append('\r'); continue }
        if ($unit -eq 0x22) { [void]$builder.Append('\"'); continue }
        if ($unit -eq 0x5C) { [void]$builder.Append('\\'); continue }
        if ($unit -lt 0x20) {
            [void]$builder.Append(('\u{0:x4}' -f $unit))
        } elseif ($unit -ge 0xD800 -and $unit -le 0xDBFF) {
            if ($index + 1 -ge $Value.Length) { throw 'Lone high surrogate' }
            $next = [int][char]$Value[$index + 1]
            if ($next -lt 0xDC00 -or $next -gt 0xDFFF) { throw 'Invalid surrogate pair' }
            [void]$builder.Append($Value[$index])
            $index++
            [void]$builder.Append($Value[$index])
        } elseif ($unit -ge 0xDC00 -and $unit -le 0xDFFF) {
            throw 'Lone low surrogate'
        } else {
            [void]$builder.Append($Value[$index])
        }
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

function ConvertTo-CanonicalJson {
    param($Value)
    if ($null -eq $Value) { return 'null' }
    if ($Value -is [bool]) { if ($Value) { return 'true' } else { return 'false' } }
    if ($Value -is [string]) { return ConvertTo-CanonicalJsonString -Value $Value }
    if ($Value -is [int64]) {
        if (-not (Test-SafeInteger $Value)) { throw 'Non-canonical integer' }
        return $Value.ToString([Globalization.CultureInfo]::InvariantCulture)
    }
    if ($Value -is [Collections.IDictionary]) {
        $keys = [string[]]@($Value.Keys)
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        $parts = New-Object Collections.Generic.List[string]
        foreach ($key in $keys) {
            $parts.Add("$(ConvertTo-CanonicalJsonString -Value $key):$(ConvertTo-CanonicalJson -Value $Value[$key])")
        }
        return '{' + ($parts -join ',') + '}'
    }
    if ($Value -is [Collections.IList] -or $Value -is [Array]) {
        $parts = New-Object Collections.Generic.List[string]
        foreach ($item in $Value) { $parts.Add((ConvertTo-CanonicalJson -Value $item)) }
        return '[' + ($parts -join ',') + ']'
    }
    throw "Unsupported canonical JSON type: $($Value.GetType().FullName)"
}

function Get-HmacSha256Bytes {
    param([Parameter(Mandatory=$true)][string]$Canonical)
    $encoding = New-Object Text.UTF8Encoding($false, $true)
    $hmac = New-Object Security.Cryptography.HMACSHA256 -ArgumentList (, $script:CapabilityBytes)
    try {
        return [byte[]]$hmac.ComputeHash($encoding.GetBytes($Canonical))
    } finally {
        $hmac.Dispose()
    }
}

function ConvertTo-LowerHex {
    param([Parameter(Mandatory=$true)][byte[]]$Value)
    return (($Value | ForEach-Object { $_.ToString('x2') }) -join '')
}

function New-ArtifactNonce {
    $bytes = New-Object byte[] 16
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
        return ConvertTo-LowerHex -Value $bytes
    } finally {
        $generator.Dispose()
        [Array]::Clear($bytes, 0, $bytes.Length)
    }
}

function ConvertFrom-LowerHex {
    param([Parameter(Mandatory=$true)][string]$Value)
    if ($Value -cnotmatch '^[0-9a-f]{64}\z') { Throw-WorkerError 'E_BAD_ENVELOPE' 'HMAC format is invalid' }
    $bytes = New-Object byte[] 32
    for ($index = 0; $index -lt 32; $index++) {
        $bytes[$index] = [Convert]::ToByte($Value.Substring($index * 2, 2), 16)
    }
    return $bytes
}

function Test-FixedTimeEqual {
    param(
        [Parameter(Mandatory=$true)][byte[]]$Left,
        [Parameter(Mandatory=$true)][byte[]]$Right
    )
    if ($Left.Length -ne $Right.Length) { return $false }
    [int]$difference = 0
    for ($index = 0; $index -lt $Left.Length; $index++) {
        $difference = $difference -bor ($Left[$index] -bxor $Right[$index])
    }
    return $difference -eq 0
}

# ---------------------------------------------------------------------------
# ACL, envelope, and action validation
# ---------------------------------------------------------------------------

function Assert-SecureTestQueueAcl {
    if (-not (Test-Path -LiteralPath $QueueDir -PathType Container)) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue is missing'
    }
    try { $expectedUserSid = New-Object Security.Principal.SecurityIdentifier($QueueUserSid) }
    catch { Throw-WorkerError 'E_QUEUE_ACL' 'Queue user SID is invalid' }
    $allowed = @($expectedUserSid.Value, 'S-1-5-32-544', 'S-1-5-18')
    $acl = Get-Acl -LiteralPath $QueueDir
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $secure = $acl.AreAccessRulesProtected -and $rules.Count -eq 3
    foreach ($rule in $rules) {
        $sid = $rule.IdentityReference.Value
        [void]$seen.Add($sid)
        if ($allowed -notcontains $sid -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
            $rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
            $rule.IsInherited -or
            $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or
            $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
            $secure = $false
        }
    }
    foreach ($sid in $allowed) { if (-not $seen.Contains($sid)) { $secure = $false } }
    if (-not $secure) { Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue ACL verification failed' }
}

function Resolve-OwnerSid {
    param([Parameter(Mandatory=$true)][string]$Owner)
    try {
        if ($Owner -match '^S-[0-9-]+\z') {
            return (New-Object Security.Principal.SecurityIdentifier($Owner)).Value
        }
        return ([Security.Principal.NTAccount]$Owner).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    } catch {
        return $null
    }
}

function Get-TrustedOwnerSidSet {
    $trusted = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($sid in @(
        'S-1-5-18',
        'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    )) { [void]$trusted.Add($sid) }
    return $trusted
}

function Test-ExpectedProductionQueueRootOwner {
    param([Parameter(Mandatory=$true)][string]$OwnerSid)
    return $OwnerSid -ceq 'S-1-5-32-544'
}

function Assert-TrustedProductionQueueRoot {
    $expectedRoot = [IO.Path]::GetFullPath($script:ProductionQueueRoot).TrimEnd('\')
    $actualRoot = [IO.Path]::GetFullPath($QueueRoot).TrimEnd('\')
    if (-not $actualRoot.Equals($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Production queue root is not the fixed installer path'
    }
    if (-not (Test-Path -LiteralPath $expectedRoot -PathType Container)) {
        Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Installer-provisioned queue root is missing'
    }

    $trustedOwners = Get-TrustedOwnerSidSet
    $rootDangerousRights = [int64](
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $ancestorReplacementRights = [int64](
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )

    $node = Get-Item -LiteralPath $expectedRoot -Force
    $isRoot = $true
    while ($null -ne $node) {
        if (($node.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Queue root or ancestor is a reparse point'
        }
        $acl = Get-Acl -LiteralPath $node.FullName
        if ($isRoot -and -not $acl.AreAccessRulesProtected) {
            Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Queue root ACL is not protected'
        }
        $ownerSid = Resolve-OwnerSid -Owner $acl.Owner
        if ($isRoot) {
            if ([string]::IsNullOrWhiteSpace($ownerSid) -or
                -not (Test-ExpectedProductionQueueRootOwner -OwnerSid $ownerSid)) {
                Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Queue root owner is not BUILTIN\Administrators'
            }
        } elseif ([string]::IsNullOrWhiteSpace($ownerSid) -or
            -not $trustedOwners.Contains($ownerSid)) {
            Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Queue ancestor has an untrusted owner'
        }
        $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
        foreach ($rule in $rules) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $trustedOwners.Contains($rule.IdentityReference.Value) -or
                ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) {
                continue
            }
            $forbidden = if ($isRoot) { $rootDangerousRights } else { $ancestorReplacementRights }
            if (([int64]$rule.FileSystemRights -band $forbidden) -ne 0) {
                Throw-WorkerError 'E_QUEUE_ROOT_TRUST' 'Untrusted principal can modify or replace the queue boundary'
            }
        }
        $isRoot = $false
        $node = $node.Parent
    }
}

function New-ProductionQueueLeafSecurity {
    param([Parameter(Mandatory=$true)][string]$UserSidText)
    try { $userSid = New-Object Security.Principal.SecurityIdentifier($UserSidText) }
    catch { Throw-WorkerError 'E_QUEUE_ACL' 'Queue user SID is invalid' }
    $adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
    $systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
    $security = New-Object Security.AccessControl.DirectorySecurity
    $security.SetAccessRuleProtection($true, $false)
    $security.SetOwner($adminSid)

    foreach ($sid in @($adminSid, $systemSid)) {
        $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
            $sid,
            [Security.AccessControl.FileSystemRights]::FullControl,
            [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
            [Security.AccessControl.PropagationFlags]::None,
            [Security.AccessControl.AccessControlType]::Allow
        )))
    }
    $directoryRights = [Security.AccessControl.FileSystemRights](
        [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [Security.AccessControl.FileSystemRights]::WriteData
    )
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $userSid,
        $directoryRights,
        [Security.AccessControl.InheritanceFlags]::None,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $userSid,
        [Security.AccessControl.FileSystemRights]::Modify,
        [Security.AccessControl.InheritanceFlags]::ObjectInherit,
        [Security.AccessControl.PropagationFlags]::InheritOnly,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    return $security
}

function New-ProductionQueueLeaf {
    Assert-TrustedProductionQueueRoot
    if ($PSVersionTable.PSEdition -cne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Production queue creation requires Windows PowerShell 5.1'
    }
    $expectedLeaf = Join-Path $script:ProductionQueueRoot $SessionId
    if (-not [IO.Path]::GetFullPath($QueueDir).Equals(
            [IO.Path]::GetFullPath($expectedLeaf), [StringComparison]::OrdinalIgnoreCase)) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Queue leaf is not the authenticated session path'
    }
    if ([IO.Directory]::Exists($QueueDir)) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Authenticated queue leaf already exists'
    }
    $security = New-ProductionQueueLeafSecurity -UserSidText $QueueUserSid
    try {
        # The DirectorySecurity overload creates the directory and applies its
        # owner and DACL in one kernel-backed operation. Production never uses a
        # create-then-SetAcl sequence because the owner would gain WRITE_DAC in
        # the gap even when the parent itself is protected.
        [IO.Directory]::CreateDirectory($QueueDir, $security) | Out-Null
    } catch {
        Throw-WorkerError 'E_QUEUE_ACL' "Could not create the protected queue leaf: $($_.Exception.Message)"
    }
}

function Assert-SecureProductionQueueLeaf {
    Assert-TrustedProductionQueueRoot
    if (-not (Test-Path -LiteralPath $QueueDir -PathType Container)) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue leaf is missing'
    }
    $item = Get-Item -LiteralPath $QueueDir -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue leaf is a reparse point'
    }
    if (-not $item.Parent.FullName.Equals(
            [IO.Path]::GetFullPath($script:ProductionQueueRoot).TrimEnd('\'),
            [StringComparison]::OrdinalIgnoreCase) -or $item.Name -cne $SessionId) {
        Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue leaf is outside the fixed session boundary'
    }
    try { $expectedUserSid = New-Object Security.Principal.SecurityIdentifier($QueueUserSid) }
    catch { Throw-WorkerError 'E_QUEUE_ACL' 'Queue user SID is invalid' }
    $adminSid = 'S-1-5-32-544'
    $systemSid = 'S-1-5-18'
    $acl = Get-Acl -LiteralPath $QueueDir
    $ownerSid = Resolve-OwnerSid -Owner $acl.Owner
    $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
    $secure = $acl.AreAccessRulesProtected -and $ownerSid -ceq $adminSid -and $rules.Count -eq 4
    $trustedSeen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $userDirectorySeen = $false
    $userFileSeen = $false
    $expectedDirectoryRights = [int64](
        [Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    )
    $expectedFileRights = [int64](
        [Security.AccessControl.FileSystemRights]::Modify -bor
        [Security.AccessControl.FileSystemRights]::Synchronize
    )
    foreach ($rule in $rules) {
        if ($rule.IsInherited -or
            $rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) {
            $secure = $false
            continue
        }
        $sid = $rule.IdentityReference.Value
        if ($sid -ceq $adminSid -or $sid -ceq $systemSid) {
            [void]$trustedSeen.Add($sid)
            if ($rule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or
                $rule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' -or
                $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) {
                $secure = $false
            }
        } elseif ($sid -ceq $expectedUserSid.Value) {
            if ([int64]$rule.FileSystemRights -eq $expectedDirectoryRights -and
                $rule.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::None -and
                $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) {
                if ($userDirectorySeen) { $secure = $false }
                $userDirectorySeen = $true
            } elseif ([int64]$rule.FileSystemRights -eq $expectedFileRights -and
                $rule.InheritanceFlags -eq [Security.AccessControl.InheritanceFlags]::ObjectInherit -and
                $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::InheritOnly) {
                if ($userFileSeen) { $secure = $false }
                $userFileSeen = $true
            } else {
                $secure = $false
            }
        } else {
            $secure = $false
        }
    }
    if ($trustedSeen.Count -ne 2 -or -not $userDirectorySeen -or -not $userFileSeen) { $secure = $false }
    if (-not $secure) { Throw-WorkerError 'E_QUEUE_ACL' 'Worker queue leaf ACL verification failed' }
}

function Assert-SecureQueueBoundary {
    if ($TestMode) { Assert-SecureTestQueueAcl }
    else { Assert-SecureProductionQueueLeaf }
}

function Initialize-TrustedExecutionEnvironment {
    $systemDirectory = [Environment]::SystemDirectory
    $windowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    if ([string]::IsNullOrWhiteSpace($systemDirectory) -or
        [string]::IsNullOrWhiteSpace($windowsDirectory)) {
        Throw-WorkerError 'E_ACTION_HOST_MISSING' 'Trusted Windows directories are unavailable'
    }

    $script:TrustedPowerShellPath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $script:TrustedPowerShellPath -PathType Leaf)) {
        Throw-WorkerError 'E_ACTION_HOST_MISSING' 'Trusted Windows PowerShell host is unavailable'
    }

    # Child actions use absolute executables, and every search-related variable is
    # reduced to Windows-owned locations so user-writable PATH/module entries cannot
    # influence native executable or module discovery inside an action script.
    $env:SystemRoot = $windowsDirectory
    $env:windir = $windowsDirectory
    $env:ComSpec = Join-Path $systemDirectory 'cmd.exe'
    $env:PATH = @(
        $systemDirectory,
        $windowsDirectory,
        (Join-Path $systemDirectory 'Wbem'),
        (Join-Path $systemDirectory 'WindowsPowerShell\v1.0')
    ) -join ';'
    $env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
    $env:PSModulePath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\Modules'
}

function Assert-ExactKeys {
    param(
        [Parameter(Mandatory=$true)][Collections.IDictionary]$Object,
        [Parameter(Mandatory=$true)][string[]]$Required,
        [string[]]$Optional = @(),
        [string]$Code = 'E_BAD_ENVELOPE'
    )
    foreach ($key in $Required) { if (-not $Object.ContainsKey($key)) { Throw-WorkerError $Code "Missing property: $key" } }
    $allowed = @($Required) + @($Optional)
    foreach ($key in $Object.Keys) { if ($allowed -cnotcontains $key) { Throw-WorkerError $Code "Unknown property: $key" } }
}

function Assert-StringParam {
    param(
        [Collections.IDictionary]$Params,
        [string]$Name,
        [string[]]$Values = @(),
        [switch]$SafeName
    )
    $value = $Params[$Name]
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) {
        Throw-WorkerError 'E_INVALID_PARAMS' "Invalid string parameter: $Name"
    }
    if ($Values.Count -gt 0 -and $Values -cnotcontains $value) {
        Throw-WorkerError 'E_INVALID_PARAMS' "Invalid value for parameter: $Name"
    }
    if ($SafeName -and $value -cnotmatch '^[A-Za-z0-9._-]{1,128}\z') {
        Throw-WorkerError 'E_INVALID_PARAMS' "Invalid safe-name parameter: $Name"
    }
}

function Assert-IntegerParam {
    param([Collections.IDictionary]$Params, [string]$Name, [int64]$Min, [int64]$Max)
    $value = $Params[$Name]
    if ($value -isnot [int64] -or $value -lt $Min -or $value -gt $Max) {
        Throw-WorkerError 'E_INVALID_PARAMS' "Invalid integer parameter: $Name"
    }
}

function Add-DryRunArgument {
    param([Collections.IDictionary]$Params, [Collections.ArrayList]$Arguments)
    if ($Params.ContainsKey('dry_run')) {
        if ($Params['dry_run'] -isnot [bool]) { Throw-WorkerError 'E_INVALID_PARAMS' 'dry_run must be boolean' }
        if ($Params['dry_run']) { [void]$Arguments.Add('-DryRun') }
    }
}

function Get-ActionArguments {
    param(
        [Parameter(Mandatory=$true)][string]$Action,
        [Parameter(Mandatory=$true)][Collections.IDictionary]$Params
    )
    $arguments = New-Object Collections.ArrayList
    switch -CaseSensitive ($Action) {
        'set-service-startup' {
            Assert-ExactKeys $Params @('service', 'startup_type') @('dry_run') 'E_INVALID_PARAMS'
            Assert-StringParam $Params 'service' -SafeName
            Assert-StringParam $Params 'startup_type' @('Automatic', 'AutomaticDelayedStart', 'Manual', 'Disabled')
            [void]$arguments.Add('-Service'); [void]$arguments.Add($Params['service'])
            [void]$arguments.Add('-StartupType'); [void]$arguments.Add($Params['startup_type'])
        }
        { $_ -ceq 'stop-service' -or $_ -ceq 'start-service' } {
            Assert-ExactKeys $Params @('service') @('dry_run') 'E_INVALID_PARAMS'
            Assert-StringParam $Params 'service' -SafeName
            [void]$arguments.Add('-Service'); [void]$arguments.Add($Params['service'])
        }
        'restart-service' {
            Assert-ExactKeys $Params @('service') @('dry_run') 'E_INVALID_PARAMS'
            Assert-StringParam $Params 'service' -SafeName
            [void]$arguments.Add('-ServiceName'); [void]$arguments.Add($Params['service'])
        }
        'kill-process' {
            Assert-ExactKeys $Params @('target') @('dry_run') 'E_INVALID_PARAMS'
            Assert-StringParam $Params 'target' -SafeName
            [void]$arguments.Add('-Target'); [void]$arguments.Add($Params['target'])
        }
        'set-process-priority' {
            Assert-ExactKeys $Params @('target', 'class') @('dry_run') 'E_INVALID_PARAMS'
            Assert-IntegerParam $Params 'target' 1 2147483647
            Assert-StringParam $Params 'class' @('Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'RealTime')
            [void]$arguments.Add('-Target'); [void]$arguments.Add("$($Params['target'])")
            [void]$arguments.Add('-Class'); [void]$arguments.Add($Params['class'])
        }
        'set-process-affinity' {
            Assert-ExactKeys $Params @('target', 'mask') @('dry_run') 'E_INVALID_PARAMS'
            Assert-IntegerParam $Params 'target' 1 2147483647
            Assert-IntegerParam $Params 'mask' 1 9007199254740991
            [void]$arguments.Add('-Target'); [void]$arguments.Add("$($Params['target'])")
            [void]$arguments.Add('-Mask'); [void]$arguments.Add("$($Params['mask'])")
        }
        { $_ -ceq 'suspend-process' -or $_ -ceq 'resume-process' } {
            Assert-ExactKeys $Params @('target') @('dry_run') 'E_INVALID_PARAMS'
            Assert-IntegerParam $Params 'target' 1 2147483647
            [void]$arguments.Add('-Target'); [void]$arguments.Add("$($Params['target'])")
        }
        'test-echo' {
            if (-not $TestMode) { Throw-WorkerError 'E_INVALID_ACTION' 'Unknown action: test-echo' }
            Assert-ExactKeys $Params @('value') @('delay_ms') 'E_INVALID_PARAMS'
            Assert-StringParam $Params 'value'
            [void]$arguments.Add('-Value'); [void]$arguments.Add($Params['value'])
            if ($Params.ContainsKey('delay_ms')) {
                Assert-IntegerParam $Params 'delay_ms' 0 5000
                [void]$arguments.Add('-DelayMilliseconds'); [void]$arguments.Add("$($Params['delay_ms'])")
            }
        }
        default {
            if ($Action -match '^(?i:reboot|shutdown|restart-computer|shutdown-computer)\z') {
                Throw-WorkerError 'E_REBOOT_FORBIDDEN' 'Reboot and shutdown actions are forbidden'
            }
            Throw-WorkerError 'E_INVALID_ACTION' "Unknown action: $Action"
        }
    }
    Add-DryRunArgument $Params $arguments
    [void]$arguments.Add('-JsonOutput')
    return $arguments.ToArray()
}

function Get-ValidationNow {
    if ($TestMode -and $TestNowMilliseconds -ge 0) { return $TestNowMilliseconds }
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

function Test-WorkerEnvelope {
    param(
        [Parameter(Mandatory=$true)][Collections.IDictionary]$Command,
        [Parameter(Mandatory=$true)][string]$ExpectedId,
        [Parameter(Mandatory=$true)]$AcceptedNonces
    )
    $required = @('version', 'session_id', 'id', 'action', 'params', 'issued_at', 'expires_at', 'nonce', 'hmac_sha256')
    $optional = @('policy_id', 'intent_id')
    Assert-ExactKeys $Command $required $optional 'E_BAD_ENVELOPE'

    $hasPolicy = $Command.ContainsKey('policy_id')
    $hasIntent = $Command.ContainsKey('intent_id')
    if ($hasPolicy -ne $hasIntent) {
        Throw-WorkerError 'E_AUTOMATIC_CAPABILITY_REQUIRED' 'Policy and intent IDs must appear together'
    }
    if ($Command['version'] -isnot [int64] -or $Command['version'] -ne 2 -or
        $Command['session_id'] -isnot [string] -or
        $Command['id'] -isnot [string] -or $Command['id'] -cnotmatch '^[0-9a-f]{32}\z' -or
        $Command['action'] -isnot [string] -or
        $Command['params'] -isnot [Collections.IDictionary] -or
        $Command['issued_at'] -isnot [int64] -or $Command['expires_at'] -isnot [int64] -or
        $Command['nonce'] -isnot [string] -or $Command['nonce'] -cnotmatch '^[0-9a-f]{32}\z' -or
        $Command['hmac_sha256'] -isnot [string]) {
        Throw-WorkerError 'E_BAD_ENVELOPE' 'Envelope field type or format is invalid'
    }
    if ($Command['id'] -cne $ExpectedId) { Throw-WorkerError 'E_BAD_ENVELOPE' 'Envelope ID does not match file name' }
    if ($Command['session_id'] -cne $SessionId) { Throw-WorkerError 'E_WRONG_SESSION' 'Wrong worker session' }

    $now = Get-ValidationNow
    if ($Command['expires_at'] -le $now) { Throw-WorkerError 'E_ENVELOPE_EXPIRED' 'Envelope expired' }
    if ($Command['issued_at'] -gt $now + 5000) { Throw-WorkerError 'E_ENVELOPE_FUTURE' 'Envelope issued too far in future' }
    $lifetime = $Command['expires_at'] - $Command['issued_at']
    if ($lifetime -le 0 -or $lifetime -gt 30000) {
        Throw-WorkerError 'E_ENVELOPE_LIFETIME' 'Envelope lifetime exceeds 30 seconds'
    }

    $unsigned = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::Ordinal)
    foreach ($key in $Command.Keys) { if ($key -cne 'hmac_sha256') { $unsigned.Add($key, $Command[$key]) } }
    $expectedHmac = Get-HmacSha256Bytes -Canonical (ConvertTo-CanonicalJson -Value $unsigned)
    $suppliedHmac = ConvertFrom-LowerHex -Value $Command['hmac_sha256']
    if (-not (Test-FixedTimeEqual $expectedHmac $suppliedHmac)) {
        Throw-WorkerError 'E_BAD_HMAC' 'Envelope authentication failed'
    }

    if ($Command['action'] -match '^(?i:reboot|shutdown|restart-computer|shutdown-computer)\z') {
        Throw-WorkerError 'E_REBOOT_FORBIDDEN' 'Reboot and shutdown actions are forbidden'
    }
    $arguments = @(Get-ActionArguments -Action $Command['action'] -Params $Command['params'])
    if ($hasPolicy) {
        if ($Command['policy_id'] -isnot [string] -or [string]::IsNullOrWhiteSpace($Command['policy_id']) -or
            $Command['intent_id'] -isnot [string] -or [string]::IsNullOrWhiteSpace($Command['intent_id'])) {
            Throw-WorkerError 'E_AUTOMATIC_CAPABILITY_REQUIRED' 'Automatic identifiers must be non-empty'
        }
        # Every current worker action is compiled as automation: never and rebootPolicy: never.
        Throw-WorkerError 'E_AUTOMATION_NEVER' 'Current worker actions are never automatic'
    }

    # Replay is checked and consumed last. Invalid HMAC/schema files cannot poison
    # a genuine nonce, while every accepted nonce remains consumed even if action fails.
    if ($AcceptedNonces.Contains($Command['nonce'])) { Throw-WorkerError 'E_REPLAY' 'Nonce already accepted' }
    [void]$AcceptedNonces.Add($Command['nonce'])
    return $arguments
}

# ---------------------------------------------------------------------------
# Explicit action dispatch and atomic results
# ---------------------------------------------------------------------------

$ActionMap = @{
    'set-service-startup' = 'actions\Set-ServiceStartup.ps1'
    'stop-service' = 'actions\Stop-Service.ps1'
    'start-service' = 'actions\Start-Service.ps1'
    'restart-service' = 'actions\Restart-Service.ps1'
    'kill-process' = 'actions\Kill-Process.ps1'
    'set-process-priority' = 'actions\Set-ProcessPriority.ps1'
    'set-process-affinity' = 'actions\Set-ProcessAffinity.ps1'
    'suspend-process' = 'actions\Suspend-Process.ps1'
    'resume-process' = 'actions\Resume-Process.ps1'
}

function Invoke-ActionProcess {
    param(
        [Parameter(Mandatory=$true)][string]$ScriptPath,
        [Parameter(Mandatory=$true)][object[]]$Arguments
    )

    # Only this constant wrapper reaches the child command line. Script path and
    # validated arguments travel in process environment values, avoiding Windows
    # command-line quoting ambiguities for attacker-controlled service names.
$wrapper = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
$utf8 = New-Object Text.UTF8Encoding($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$systemDirectory = Join-Path $env:SystemRoot 'System32'
$env:PATHEXT = '.COM;.EXE;.BAT;.CMD'
$env:PSModulePath = Join-Path $systemDirectory 'WindowsPowerShell\v1.0\Modules'
$scriptPath = [Environment]::GetEnvironmentVariable('PCDOCTOR_ACTION_SCRIPT_V2', 'Process')
$argumentCount = [int]::Parse(
    [Environment]::GetEnvironmentVariable('PCDOCTOR_ACTION_ARGUMENT_COUNT_V2', 'Process'),
    [Globalization.CultureInfo]::InvariantCulture)
[Environment]::SetEnvironmentVariable('PCDOCTOR_ACTION_SCRIPT_V2', $null, 'Process')
[Environment]::SetEnvironmentVariable('PCDOCTOR_ACTION_ARGUMENT_COUNT_V2', $null, 'Process')
if ($argumentCount -lt 0 -or $argumentCount -gt 32) { throw 'Invalid action argument count' }
$actionArguments = New-Object Collections.Generic.List[object]
for ($index = 0; $index -lt $argumentCount; $index++) {
    $name = "PCDOCTOR_ACTION_ARGUMENT_${index}_V2"
    $argumentBytes = [Convert]::FromBase64String(
        [Environment]::GetEnvironmentVariable($name, 'Process'))
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    try {
        $actionArguments.Add((New-Object Text.UTF8Encoding($false, $true)).GetString($argumentBytes))
    } finally {
        [Array]::Clear($argumentBytes, 0, $argumentBytes.Length)
    }
}
$tokens = $actionArguments.ToArray()
$namedArguments = @{}
for ($index = 0; $index -lt $tokens.Count;) {
    $token = [string]$tokens[$index]
    if ($token -cnotmatch '^-[A-Za-z]+\z') { throw 'Invalid action argument token' }
    $name = $token.Substring(1)
    if ($name -ceq 'DryRun' -or $name -ceq 'JsonOutput') {
        $namedArguments[$name] = $true
        $index++
        continue
    }
    if (@('Service', 'StartupType', 'ServiceName', 'Target', 'Class', 'Mask',
            'Value', 'DelayMilliseconds') -cnotcontains $name -or $index + 1 -ge $tokens.Count) {
        throw 'Invalid action argument name or value'
    }
    $namedArguments[$name] = [string]$tokens[$index + 1]
    $index += 2
}
& $scriptPath @namedArguments
'@
    $wrapperBytes = [Text.Encoding]::Unicode.GetBytes($wrapper)
    $encodedWrapper = [Convert]::ToBase64String($wrapperBytes)
    [Array]::Clear($wrapperBytes, 0, $wrapperBytes.Length)

    $startInfo = New-Object Diagnostics.ProcessStartInfo
    $startInfo.FileName = $script:TrustedPowerShellPath
    $startInfo.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedWrapper"
    $startInfo.WorkingDirectory = $BasePath
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $utf8 = New-Object Text.UTF8Encoding($false, $true)
    $startInfo.StandardOutputEncoding = $utf8
    $startInfo.StandardErrorEncoding = $utf8
    [void]$startInfo.EnvironmentVariables.Remove($CapabilityEnvironmentName)
    $startInfo.EnvironmentVariables['PCDOCTOR_ACTION_SCRIPT_V2'] = $ScriptPath
    $startInfo.EnvironmentVariables['PCDOCTOR_ACTION_ARGUMENT_COUNT_V2'] =
        $Arguments.Count.ToString([Globalization.CultureInfo]::InvariantCulture)
    for ($index = 0; $index -lt $Arguments.Count; $index++) {
        $argumentBytes = (New-Object Text.UTF8Encoding($false, $true)).GetBytes([string]$Arguments[$index])
        try {
            $startInfo.EnvironmentVariables["PCDOCTOR_ACTION_ARGUMENT_${index}_V2"] =
                [Convert]::ToBase64String($argumentBytes)
        } finally {
            [Array]::Clear($argumentBytes, 0, $argumentBytes.Length)
        }
    }

    $process = New-Object Diagnostics.Process
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) { Throw-WorkerError 'E_ACTION_HOST_FAILED' 'Action host did not start' }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        $heartbeatWait = [Math]::Min([Math]::Max($PollIntervalMs, 20), 1000)
        Update-Heartbeat
        while (-not $process.WaitForExit($heartbeatWait)) { Update-Heartbeat }
        $process.WaitForExit()
        Update-Heartbeat

        $standardOutput = $stdoutTask.Result.Trim()
        $standardError = $stderrTask.Result.Trim()
        $combined = @($standardOutput, $standardError) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        return [ordered]@{
            output = ($combined -join [Environment]::NewLine)
            exit_code = [int64]$process.ExitCode
        }
    } catch {
        if ($_.Exception.Data -and $_.Exception.Data['code']) { throw }
        Throw-WorkerError 'E_ACTION_HOST_FAILED' "Trusted action host failed: $($_.Exception.Message)"
    } finally {
        $process.Dispose()
    }
}

function Invoke-CmdAction {
    param(
        [Parameter(Mandatory=$true)][Collections.IDictionary]$Command,
        [Parameter(Mandatory=$true)][object[]]$Arguments
    )
    $action = $Command['action']
    if ($TestMode) {
        if ($action -cne 'test-echo') {
            Throw-WorkerError 'E_TEST_MODE_NO_EXECUTION' 'TestMode validated but will not execute production actions'
        }
        $scriptPath = Join-Path $BasePath 'test-actions\Test-Echo.ps1'
    } else {
        if (-not $ActionMap.ContainsKey($action)) { Throw-WorkerError 'E_INVALID_ACTION' "Unknown action: $action" }
        $scriptPath = Join-Path $BasePath $ActionMap[$action]
    }
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        Throw-WorkerError 'E_ACTION_SCRIPT_MISSING' "Action script not found: $scriptPath"
    }

    $execution = Invoke-ActionProcess -ScriptPath $scriptPath -Arguments $Arguments
    $exitCode = $execution['exit_code']
    $joined = $execution['output']
    if ($joined.StartsWith('PCDOCTOR_ERROR:')) {
        $errorObject = $null
        try { $errorObject = ConvertFrom-StrictJson -Text $joined.Substring('PCDOCTOR_ERROR:'.Length) } catch {}
        $code = if ($errorObject -is [Collections.IDictionary] -and $errorObject['code'] -is [string]) {
            $errorObject['code']
        } else { 'E_ACTION_FAILED' }
        $message = if ($errorObject -is [Collections.IDictionary] -and $errorObject['message'] -is [string]) {
            $errorObject['message']
        } else { 'Action failed' }
        Throw-WorkerError $code $message
    }
    if ($exitCode -ne 0) {
        $detail = if ([string]::IsNullOrWhiteSpace($joined)) { '' } else { ": $joined" }
        Throw-WorkerError 'E_ACTION_FAILED' "Action exited $exitCode$detail"
    }
    try {
        $parsed = ConvertFrom-StrictJson -Text $joined
        if ($parsed -is [Array]) {
            Write-Output -NoEnumerate $parsed
            return
        }
        return $parsed
    }
    catch { Throw-WorkerError 'E_ACTION_FAILED' 'Action returned invalid JSON' }
}

function Write-AtomicJson {
    param(
        [Parameter(Mandatory=$true)][string]$Destination,
        [Parameter(Mandatory=$true)]$Payload
    )
    Assert-SecureQueueBoundary
    $directory = Split-Path -Parent $Destination
    $leaf = Split-Path -Leaf $Destination
    $temporary = Join-Path $directory "$leaf.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $Payload | ConvertTo-Json -Depth 8 -Compress
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        # Same-directory File.Move is the atomic publication point. Existing
        # destinations fail instead of overwriting a possibly untrusted result.
        [IO.File]::Move($temporary, $Destination)
    } catch {
        try { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } } catch {}
        throw
    }
}

function Write-AtomicHeartbeat {
    param([Parameter(Mandatory=$true)]$Payload)
    Assert-SecureQueueBoundary
    $directory = Split-Path -Parent $script:HeartbeatFile
    $leaf = Split-Path -Leaf $script:HeartbeatFile
    $publicationId = [Guid]::NewGuid().ToString('N')
    $temporary = Join-Path $directory "$leaf.$publicationId.tmp"
    $backup = Join-Path $directory "$leaf.$publicationId.bak"
    try {
        $json = $Payload | ConvertTo-Json -Depth 8 -Compress
        [IO.File]::WriteAllText($temporary, $json, (New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $script:HeartbeatFile -PathType Leaf) {
            # PowerShell 5.1 coerces a null backup argument to an illegal empty
            # path. A unique same-directory backup preserves atomic replacement;
            # it is deleted immediately after the publication point.
            [IO.File]::Replace($temporary, $script:HeartbeatFile, $backup)
        } else {
            [IO.File]::Move($temporary, $script:HeartbeatFile)
        }
    } finally {
        try { if (Test-Path -LiteralPath $temporary -PathType Leaf) { [IO.File]::Delete($temporary) } } catch {}
        try { if (Test-Path -LiteralPath $backup -PathType Leaf) { [IO.File]::Delete($backup) } } catch {}
    }
}

function Update-Heartbeat {
    $issuedAt = [int64](Get-ValidationNow)
    $unsigned = [ordered]@{
        version = [int64]2
        session_id = $SessionId
        worker_pid = [int64]$PID
        issued_at = $issuedAt
        expires_at = [int64]($issuedAt + 30000)
        nonce = New-ArtifactNonce
    }
    $hmac = Get-HmacSha256Bytes -Canonical (ConvertTo-CanonicalJson -Value $unsigned)
    try {
        $heartbeat = [ordered]@{}
        foreach ($key in $unsigned.Keys) { $heartbeat[$key] = $unsigned[$key] }
        $heartbeat['hmac_sha256'] = ConvertTo-LowerHex -Value $hmac
        Write-AtomicHeartbeat -Payload $heartbeat
    } catch {} finally {
        [Array]::Clear($hmac, 0, $hmac.Length)
    }
}

$script:HeartbeatFile = $null
$acceptedNonces = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)

function Get-ResultAction {
    param($Command)
    if ($Command -is [Collections.IDictionary] -and $Command['action'] -is [string] -and
        $Command['action'].Length -ge 1 -and $Command['action'].Length -le 128) {
        return $Command['action']
    }
    return 'invalid-command'
}

function New-SignedResult {
    param(
        [Parameter(Mandatory=$true)][string]$Id,
        [Parameter(Mandatory=$true)][string]$Action,
        [Parameter(Mandatory=$true)][bool]$Success,
        [Parameter(Mandatory=$true)][int64]$DurationMilliseconds,
        $Data,
        [string]$ErrorCode,
        [string]$ErrorMessage
    )
    $issuedAt = [int64](Get-ValidationNow)
    $unsigned = [ordered]@{
        version = [int64]2
        session_id = $SessionId
        id = $Id
        action = $Action
        success = $Success
        duration_ms = $DurationMilliseconds
    }
    if ($Success) {
        $unsigned['data'] = $Data
    } else {
        if ([string]::IsNullOrEmpty($ErrorCode)) { $ErrorCode = 'E_ACTION_FAILED' }
        if ($ErrorCode.Length -gt 256) { $ErrorCode = $ErrorCode.Substring(0, 256) }
        if ($null -eq $ErrorMessage) { $ErrorMessage = '' }
        if ($ErrorMessage.Length -gt 4096) { $ErrorMessage = $ErrorMessage.Substring(0, 4096) }
        $unsigned['error'] = [ordered]@{ code = $ErrorCode; message = $ErrorMessage }
    }
    $unsigned['issued_at'] = $issuedAt
    $unsigned['nonce'] = New-ArtifactNonce
    $hmac = Get-HmacSha256Bytes -Canonical (ConvertTo-CanonicalJson -Value $unsigned)
    try {
        $result = [ordered]@{}
        foreach ($key in $unsigned.Keys) { $result[$key] = $unsigned[$key] }
        $result['hmac_sha256'] = ConvertTo-LowerHex -Value $hmac
        return $result
    } finally {
        [Array]::Clear($hmac, 0, $hmac.Length)
    }
}

try {
    if ([string]::IsNullOrWhiteSpace($capabilityText)) { Throw-WorkerError 'E_CAPABILITY_REQUIRED' 'Worker capability missing' }
    try { $script:CapabilityBytes = [Convert]::FromBase64String($capabilityText) }
    catch { Throw-WorkerError 'E_CAPABILITY_REQUIRED' 'Worker capability encoding invalid' }
    $capabilityText = $null
    if ($script:CapabilityBytes.Length -ne 32) { Throw-WorkerError 'E_CAPABILITY_REQUIRED' 'Worker capability must be 32 bytes' }
    if ($SessionId -cnotmatch '^[0-9a-f]{32}\z') { Throw-WorkerError 'E_BAD_SESSION' 'Worker session ID format invalid' }
    if ($IdleTimeoutSeconds -lt 1 -or $PollIntervalMs -lt 1) { Throw-WorkerError 'E_BAD_WORKER_CONFIG' 'Worker timing invalid' }
    $QueueDir = Join-Path $QueueRoot $SessionId

    if ($TestMode) {
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $fullRoot = [IO.Path]::GetFullPath($QueueRoot)
        $fullQueue = [IO.Path]::GetFullPath($QueueDir)
        $fullBase = [IO.Path]::GetFullPath($BasePath)
        if (-not $fullRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
            -not $fullQueue.Equals((Join-Path $fullRoot $SessionId), [StringComparison]::OrdinalIgnoreCase) -or
            -not $fullBase.StartsWith($fullQueue.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
            Throw-WorkerError 'E_TEST_MODE_ISOLATION' 'TestMode paths must stay under its TEMP queue'
        }
    } elseif ($TestNowMilliseconds -ge 0) {
        Throw-WorkerError 'E_TEST_MODE_ISOLATION' 'Test clock is available only in TestMode'
    }

    Initialize-TrustedExecutionEnvironment
    if ($TestMode) { Assert-SecureTestQueueAcl }
    else { New-ProductionQueueLeaf }
    Assert-SecureQueueBoundary
    $script:HeartbeatFile = Join-Path $QueueDir '.heartbeat'
    $lastActivity = [DateTime]::UtcNow
    Update-Heartbeat

    while ($true) {
        Update-Heartbeat
        if (([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) { break }

        $enumerator = $null
        $processedThisIteration = 0
        $deadlineReached = $false
        try {
            $enumerator = [IO.Directory]::EnumerateFiles(
                $QueueDir, '*.cmd.json', [IO.SearchOption]::TopDirectoryOnly
            ).GetEnumerator()
            while ($processedThisIteration -lt $MaxCommandFilesPerIteration) {
                # Check before MoveNext so enumeration itself cannot defer the
                # deadline, then check again before processing the yielded path.
                if (([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) {
                    $deadlineReached = $true
                    break
                }
                Assert-SecureQueueBoundary
                if (-not $enumerator.MoveNext()) { break }
                if (([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) {
                    $deadlineReached = $true
                    break
                }
                $processedThisIteration++
                $commandPath = [IO.Path]::GetFullPath([string]$enumerator.Current)
                $commandName = [IO.Path]::GetFileName($commandPath)
                $fileId = $commandName -replace '\.cmd\.json$', ''
            $resultFile = Join-Path $QueueDir "$fileId.result.json"
            $stopwatch = [Diagnostics.Stopwatch]::StartNew()
            $command = $null
            try {
                $raw = Read-BoundedUtf8File -Path $commandPath -MaxBytes $MaxCommandBytes
                $command = ConvertFrom-StrictJson -Text $raw
                if ($command -isnot [Collections.IDictionary]) { Throw-WorkerError 'E_BAD_ENVELOPE' 'Envelope must be object' }
            } catch {
                $stopwatch.Stop()
                $result = New-SignedResult -Id $fileId -Action 'invalid-command' -Success $false `
                    -DurationMilliseconds $stopwatch.ElapsedMilliseconds -ErrorCode 'E_BAD_CMD' `
                    -ErrorMessage "$($_.Exception.Message)"
                try { Write-AtomicJson -Destination $resultFile -Payload $result } catch {}
                try { Assert-SecureQueueBoundary; [IO.File]::Delete($commandPath) } catch {}
                continue
            }

            $result = $null
            $acceptedEnvelope = $false
            try {
                $arguments = @(Test-WorkerEnvelope -Command $command -ExpectedId $fileId -AcceptedNonces $acceptedNonces)
                $acceptedEnvelope = $true
                $data = Invoke-CmdAction -Command $command -Arguments $arguments
                $stopwatch.Stop()
                $result = New-SignedResult -Id $fileId -Action (Get-ResultAction $command) -Success $true `
                    -DurationMilliseconds $stopwatch.ElapsedMilliseconds -Data $data
            } catch {
                $stopwatch.Stop()
                $code = 'E_ACTION_FAILED'
                if ($_.Exception.Data -and $_.Exception.Data['code']) { $code = "$($_.Exception.Data['code'])" }
                $result = New-SignedResult -Id $fileId -Action (Get-ResultAction $command) -Success $false `
                    -DurationMilliseconds $stopwatch.ElapsedMilliseconds -ErrorCode $code `
                    -ErrorMessage "$($_.Exception.Message)"
            }

            try { Write-AtomicJson -Destination $resultFile -Payload $result } catch {}
            try { Assert-SecureQueueBoundary; [IO.File]::Delete($commandPath) } catch {}
            if ($acceptedEnvelope) { $lastActivity = [DateTime]::UtcNow }
            }
        } finally {
            if ($null -ne $enumerator -and $enumerator -is [IDisposable]) { $enumerator.Dispose() }
        }

        if ($deadlineReached -or
            ([DateTime]::UtcNow - $lastActivity).TotalSeconds -ge $IdleTimeoutSeconds) { break }
        Start-Sleep -Milliseconds $PollIntervalMs
    }
} finally {
    [Environment]::SetEnvironmentVariable($CapabilityEnvironmentName, $null, 'Process')
    $capabilityText = $null
    if ($script:CapabilityBytes) {
        [Array]::Clear($script:CapabilityBytes, 0, $script:CapabilityBytes.Length)
        $script:CapabilityBytes = $null
    }
    try {
        if (-not [string]::IsNullOrWhiteSpace($script:HeartbeatFile)) {
            Assert-SecureQueueBoundary
            [IO.File]::Delete($script:HeartbeatFile)
        }
    } catch {}
}

exit 0
