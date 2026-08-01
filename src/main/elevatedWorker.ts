/**
 * Module: elevatedWorker.ts
 * Purpose: Own the queue, ACL, capability lifecycle, UAC launch, and result I/O.
 * Dependencies: elevatedWorkerProtocol plus Node filesystem and child processes.
 * Used by: Service and process mutation modules in the Electron main process.
 * Key decisions: Protocol validation is delegated to a side-effect-free module. This
 * module never exposes the capability through arguments, JSON, logs, or global env.
 */

import {
  closeSync, existsSync, openSync, readSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import log from 'electron-log/main.js';
import { PCDOCTOR_ROOT, PWSH_FALLBACK } from './constants.js';
import {
  WORKER_ACTIONS,
  WORKER_ACTION_CONTRACTS,
  WORKER_ARTIFACT_MAX_BYTES,
  WORKER_CAPABILITY_BYTES,
  ElevatedWorkerError,
  canonicalizeJson,
  createManualWorkerEnvelope,
  signEnvelopeFields,
  snapshotWorkerActionParams,
  validateHeartbeat,
  validateEnvelope,
  validateResultEnvelope,
  type WorkerAction,
  type WorkerCommandEnvelopeV2,
  type WorkerHeartbeatEnvelopeV2,
} from './elevatedWorkerProtocol.js';

export {
  WORKER_ACTIONS,
  ElevatedWorkerError,
  type WorkerAction,
  type WorkerCommandEnvelopeV2,
} from './elevatedWorkerProtocol.js';

const CAPABILITY_ENV = 'PCDOCTOR_WORKER_CAPABILITY_V2';
const QUEUE_PROOF_SCOPE_ENV = 'PCDOCTOR_QUEUE_PROOF_SCOPE';
const QUEUE_SESSION_ID_ENV = 'PCDOCTOR_QUEUE_SESSION_ID';
const RANDOM_ID_BYTES = 16;
const HEARTBEAT_STALE_MS = 30_000;
const WORKER_SPAWN_TIMEOUT_MS = 60_000;
const DEFAULT_CMD_TIMEOUT_MS = 60_000;
const RESULT_POLL_INTERVAL_MS = 100;
const HEARTBEAT_POLL_INTERVAL_MS = 250;
const READ_CHUNK_BYTES = 64 * 1024;
const STRICT_UTF8_DECODER = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const WORKER_BASE_PATH = PCDOCTOR_ROOT;
const WORKER_QUEUE_ROOT = 'C:\\ProgramData\\PCDoctorWorkerQueue';
const WORKER_QUEUE_ROOT_OWNER_SID = 'S-1-5-32-544';
const WORKER_SCRIPT_PATH = path.win32.join(WORKER_BASE_PATH, 'worker', 'Elevated-Worker.ps1');
const WORKER_ACTION_PATHS = [
  'Set-ServiceStartup.ps1',
  'Stop-Service.ps1',
  'Start-Service.ps1',
  'Restart-Service.ps1',
  'Kill-Process.ps1',
  'Set-ProcessPriority.ps1',
  'Set-ProcessAffinity.ps1',
  'Suspend-Process.ps1',
  'Resume-Process.ps1',
].map((fileName) => path.win32.join(WORKER_BASE_PATH, 'actions', fileName));
const FILE_SYSTEM_DELETE_CHILD = 64;
const FILE_SYSTEM_DELETE = 65_536;
const FILE_SYSTEM_CHANGE_PERMISSIONS = 262_144;
const FILE_SYSTEM_TAKE_OWNERSHIP = 524_288;
const PROPAGATION_INHERIT_ONLY = 2;
const ANCESTOR_REPLACEMENT_RIGHTS = FILE_SYSTEM_DELETE_CHILD
  | FILE_SYSTEM_DELETE
  | FILE_SYSTEM_CHANGE_PERMISSIONS
  | FILE_SYSTEM_TAKE_OWNERSHIP;

// FileSystemAccessRule adds Synchronize to allow rules. These are the masks
// observed from Get-Acl, not merely the enum values passed to its constructor.
const QUEUE_USER_ACL_MODEL = Object.freeze({
  directoryRights: 1_179_819, // List/Traverse/Read + CreateFiles, never CreateDirectories.
  fileRights: 1_245_631, // Modify + Synchronize on child files only.
  directoryInheritanceFlags: 0,
  fileInheritanceFlags: 2, // ObjectInherit. ContainerInherit is 1 in .NET.
  filePropagationFlags: 2, // InheritOnly.
});

const TRUSTED_SYSTEM_ROOT = path.win32.dirname(path.win32.dirname(path.win32.dirname(
  path.win32.dirname(PWSH_FALLBACK),
)));
const TRUSTED_SYSTEM_DIRECTORY = path.win32.join(TRUSTED_SYSTEM_ROOT, 'System32');
const TRUSTED_SYSTEM_DRIVE = path.win32.parse(TRUSTED_SYSTEM_ROOT).root.replace(/[\\/]$/, '');
const TRUSTED_BASE_ENVIRONMENT: Readonly<NodeJS.ProcessEnv> = Object.freeze({
  SystemRoot: TRUSTED_SYSTEM_ROOT,
  WINDIR: TRUSTED_SYSTEM_ROOT,
  SystemDrive: TRUSTED_SYSTEM_DRIVE,
  ComSpec: path.win32.join(TRUSTED_SYSTEM_DIRECTORY, 'cmd.exe'),
  PATH: [
    TRUSTED_SYSTEM_DIRECTORY,
    TRUSTED_SYSTEM_ROOT,
    path.win32.join(TRUSTED_SYSTEM_DIRECTORY, 'Wbem'),
    path.win32.join(TRUSTED_SYSTEM_DIRECTORY, 'WindowsPowerShell', 'v1.0'),
  ].join(';'),
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  PSModulePath: [
    path.win32.join(TRUSTED_SYSTEM_DIRECTORY, 'WindowsPowerShell', 'v1.0', 'Modules'),
    'C:\\Program Files\\PowerShell\\7\\Modules',
  ].join(';'),
  TEMP: path.win32.join(TRUSTED_SYSTEM_ROOT, 'Temp'),
  TMP: path.win32.join(TRUSTED_SYSTEM_ROOT, 'Temp'),
});

function createTrustedChildEnvironment(
  extras: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  return { ...TRUSTED_BASE_ENVIRONMENT, ...extras };
}

function isUnsafeAncestorAccessRule(fileSystemRights: number, propagationFlags: number): boolean {
  if (!Number.isSafeInteger(fileSystemRights) || fileSystemRights < 0
    || !Number.isSafeInteger(propagationFlags) || propagationFlags < 0) return true;
  if ((propagationFlags & PROPAGATION_INHERIT_ONLY) !== 0) return false;
  return (fileSystemRights & ANCESTOR_REPLACEMENT_RIGHTS) !== 0;
}

// This verifier is read-only and owns the only production queue coordinate.
// The caller selects root or leaf proof and can supply only a bounded session ID.
const QUEUE_TRUST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$queueRoot = '${WORKER_QUEUE_ROOT}'
$scope = [Environment]::GetEnvironmentVariable('${QUEUE_PROOF_SCOPE_ENV}', 'Process')
$sessionId = [Environment]::GetEnvironmentVariable('${QUEUE_SESSION_ID_ENV}', 'Process')
[Environment]::SetEnvironmentVariable('${QUEUE_PROOF_SCOPE_ENV}', $null, 'Process')
[Environment]::SetEnvironmentVariable('${QUEUE_SESSION_ID_ENV}', $null, 'Process')
if ($scope -ne 'root' -and $scope -ne 'leaf') { throw 'Queue proof scope is invalid' }
if ($scope -eq 'leaf' -and $sessionId -cnotmatch '^[0-9a-f]{32}\z') {
    throw 'Queue session ID format is invalid'
}

$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')
$systemSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$allowed = @($userSid.Value, $adminSid.Value, $systemSid.Value)
$trustedOwners = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($sid in @(
    'S-1-5-18',
    'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)) { [void]$trustedOwners.Add($sid) }

$rootWriteRights = [int64](
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
)
$ancestorReplacementRights = [int64]${ANCESTOR_REPLACEMENT_RIGHTS}
$present = $true
$rootProtected = $false
$leafProtected = $false
$noReparse = $true
$trustedOwner = $true
$trustedAncestorOwner = $true
$noUntrustedWrite = $true
$ancestorDeleteSafe = $true
$boundaryOwnerSid = $null

function Resolve-PcDoctorOwnerSid([string]$owner) {
    try {
        if ($owner -match '^S-[0-9-]+\z') {
            return (New-Object Security.Principal.SecurityIdentifier($owner)).Value
        }
        return ([Security.Principal.NTAccount]$owner).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    } catch {
        return $null
    }
}

function Test-PcDoctorTrustedOwner($acl, [bool]$ancestor) {
    $ownerSid = Resolve-PcDoctorOwnerSid $acl.Owner
    $isTrusted = -not [string]::IsNullOrWhiteSpace($ownerSid) -and
        $trustedOwners.Contains($ownerSid)
    if ($ancestor -and -not $isTrusted) { $script:trustedAncestorOwner = $false }
    if (-not $ancestor -and -not $isTrusted) { $script:trustedOwner = $false }
}

function Test-PcDoctorUntrustedRights($acl, [int64]$mask, [bool]$ancestor) {
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($trustedOwners.Contains($rule.IdentityReference.Value)) { continue }
        if (($rule.PropagationFlags -band
            [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if (([int64]$rule.FileSystemRights -band $mask) -ne 0) {
            if ($ancestor) { $script:ancestorDeleteSafe = $false }
            else { $script:noUntrustedWrite = $false }
        }
    }
}

if (-not [IO.Directory]::Exists($queueRoot)) {
    $present = $false
    $noReparse = $false
    $trustedOwner = $false
    $trustedAncestorOwner = $false
    $noUntrustedWrite = $false
    $ancestorDeleteSafe = $false
} else {
    $rootItem = Get-Item -LiteralPath $queueRoot -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $noReparse = $false
    }
    $rootAcl = Get-Acl -LiteralPath $queueRoot
    $rootProtected = [bool]$rootAcl.AreAccessRulesProtected
    $boundaryOwnerSid = Resolve-PcDoctorOwnerSid $rootAcl.Owner
    if ($boundaryOwnerSid -cne $adminSid.Value) { $trustedOwner = $false }
    Test-PcDoctorUntrustedRights $rootAcl $rootWriteRights $false

    # A protected root is still replaceable through DeleteChild on an ancestor.
    # Walk to the volume root and reject reparse points or untrusted owners too.
    $ancestor = $rootItem
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $noReparse = $false
            $ancestorDeleteSafe = $false
        }
        $ancestorAcl = Get-Acl -LiteralPath $ancestor.FullName
        Test-PcDoctorTrustedOwner $ancestorAcl $true
        Test-PcDoctorUntrustedRights $ancestorAcl $ancestorReplacementRights $true
        $ancestor = $ancestor.Parent
    }
}

$queuePath = $null
$leafSecure = $true
if ($scope -eq 'leaf') {
    $queuePath = Join-Path $queueRoot $sessionId
    if (-not [IO.Directory]::Exists($queuePath)) {
        $present = $false
        $leafSecure = $false
    } else {
        $leafItem = Get-Item -LiteralPath $queuePath -Force
        if (($leafItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $noReparse = $false
            $leafSecure = $false
        }
        $acl = Get-Acl -LiteralPath $queuePath
        $leafProtected = [bool]$acl.AreAccessRulesProtected
        $ownerSid = Resolve-PcDoctorOwnerSid $acl.Owner
        $boundaryOwnerSid = $ownerSid
        if ($ownerSid -cne $adminSid.Value) {
            $trustedOwner = $false
            $leafSecure = $false
        }
        $rules = @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))
        if (-not $acl.AreAccessRulesProtected -or $rules.Count -ne 4) { $leafSecure = $false }

        $adminRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $adminSid.Value })
        $systemRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $systemSid.Value })
        $userRules = @($rules | Where-Object { $_.IdentityReference.Value -ceq $userSid.Value })
        $otherRules = @($rules | Where-Object { $allowed -cnotcontains $_.IdentityReference.Value })
        if ($adminRules.Count -ne 1 -or $systemRules.Count -ne 1 -or
            $userRules.Count -ne 2 -or $otherRules.Count -ne 0) { $leafSecure = $false }

        foreach ($rule in @($adminRules + $systemRules)) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                [int64]$rule.FileSystemRights -ne 2032127 -or $rule.IsInherited -or
                [int]$rule.InheritanceFlags -ne 3 -or [int]$rule.PropagationFlags -ne 0) {
                $leafSecure = $false
            }
        }
        $directUser = @($userRules | Where-Object {
            [int64]$_.FileSystemRights -eq ${QUEUE_USER_ACL_MODEL.directoryRights} -and
            [int]$_.InheritanceFlags -eq 0 -and [int]$_.PropagationFlags -eq 0
        })
        $fileUser = @($userRules | Where-Object {
            [int64]$_.FileSystemRights -eq ${QUEUE_USER_ACL_MODEL.fileRights} -and
            [int]$_.InheritanceFlags -eq ${QUEUE_USER_ACL_MODEL.fileInheritanceFlags} -and
            [int]$_.PropagationFlags -eq ${QUEUE_USER_ACL_MODEL.filePropagationFlags}
        })
        if ($directUser.Count -ne 1 -or $fileUser.Count -ne 1) { $leafSecure = $false }
        foreach ($rule in $userRules) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or
                $rule.IsInherited) { $leafSecure = $false }
        }
    }
}

$protected = if ($scope -eq 'leaf') { $leafProtected } else { $rootProtected }
$secure = $present -and $rootProtected -and $protected -and $noReparse -and $trustedOwner -and
    $trustedAncestorOwner -and $noUntrustedWrite -and $ancestorDeleteSafe -and $leafSecure
[ordered]@{
    secure = [bool]$secure
    scope = $scope
    queue_root = $queueRoot
    queue_dir = $queuePath
    owner_sid = $boundaryOwnerSid
    user_sid = $userSid.Value
    protected = [bool]$protected
    allowed_sids = $allowed
    no_reparse = [bool]$noReparse
    trusted_owner = [bool]$trustedOwner
    trusted_ancestor_owner = [bool]$trustedAncestorOwner
    no_untrusted_write = [bool]$noUntrustedWrite
    ancestor_delete_safe = [bool]$ancestorDeleteSafe
} | ConvertTo-Json -Compress
`;
const QUEUE_TRUST_ENCODED_COMMAND = Buffer.from(QUEUE_TRUST_SCRIPT, 'utf16le').toString('base64');

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// This verifier is fixed at build time. No path or script text comes from a
// caller, environment variable, queue artifact, or bundle fallback.
const CODE_TRUST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$root = ${quotePowerShellLiteral(WORKER_BASE_PATH)}
$workerScript = ${quotePowerShellLiteral(WORKER_SCRIPT_PATH)}
$requiredFiles = @(
${[WORKER_SCRIPT_PATH, ...WORKER_ACTION_PATHS].map((filePath) => `    ${quotePowerShellLiteral(filePath)}`).join(',\n')}
)
$requiredDirectories = @($root, (Join-Path $root 'worker'), (Join-Path $root 'actions'))
$trustedOwners = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($sid in @(
    'S-1-5-18',
    'S-1-5-32-544',
    'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
)) { [void]$trustedOwners.Add($sid) }

$dangerousRights = [int64](
    [Security.AccessControl.FileSystemRights]::WriteData -bor
    [Security.AccessControl.FileSystemRights]::AppendData -bor
    [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
    [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
    [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
    [Security.AccessControl.FileSystemRights]::Delete -bor
    [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
    [Security.AccessControl.FileSystemRights]::TakeOwnership
)
$ancestorReplacementRights = [int64]${ANCESTOR_REPLACEMENT_RIGHTS}

$present = $true
$noReparse = $true
$trustedOwner = $true
$noUntrustedWrite = $true
$protectedBoundary = $false

function Resolve-PcDoctorOwnerSid([string]$owner) {
    try {
        if ($owner -match '^S-[0-9-]+\z') {
            return (New-Object Security.Principal.SecurityIdentifier($owner)).Value
        }
        return ([Security.Principal.NTAccount]$owner).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    } catch {
        return $null
    }
}

function Test-PcDoctorNode([string]$literalPath, [bool]$isBoundary) {
    if (-not (Test-Path -LiteralPath $literalPath)) {
        $script:present = $false
        return
    }
    $item = Get-Item -LiteralPath $literalPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $script:noReparse = $false
    }
    $acl = Get-Acl -LiteralPath $literalPath
    if ($isBoundary) { $script:protectedBoundary = [bool]$acl.AreAccessRulesProtected }
    $ownerSid = Resolve-PcDoctorOwnerSid $acl.Owner
    if ([string]::IsNullOrWhiteSpace($ownerSid) -or
        -not $trustedOwners.Contains($ownerSid)) { $script:trustedOwner = $false }
    $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        if ($trustedOwners.Contains($rule.IdentityReference.Value)) { continue }
        if (($rule.PropagationFlags -band
            [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
        if (([int64]$rule.FileSystemRights -band $dangerousRights) -ne 0) {
            $script:noUntrustedWrite = $false
        }
    }
}

foreach ($directory in $requiredDirectories) { Test-PcDoctorNode $directory ($directory -eq $root) }
foreach ($file in $requiredFiles) { Test-PcDoctorNode $file $false }

# A protected leaf is still replaceable when an untrusted principal has
# DeleteChild on its parent. Walk through ProgramData and the volume root so
# create/delete rights on an ancestor invalidate the proof.
$ancestorDeleteSafe = $true
$ancestorUntrustedRights = [int64]0
$trustedAncestorOwner = $true
if (Test-Path -LiteralPath $root -PathType Container) {
    $ancestor = Get-Item -LiteralPath $root -Force
    while ($null -ne $ancestor) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            $noReparse = $false
            $ancestorDeleteSafe = $false
        }
        $ancestorAcl = Get-Acl -LiteralPath $ancestor.FullName
        $ancestorOwnerSid = Resolve-PcDoctorOwnerSid $ancestorAcl.Owner
        if ([string]::IsNullOrWhiteSpace($ancestorOwnerSid) -or
            -not $trustedOwners.Contains($ancestorOwnerSid)) {
            $trustedAncestorOwner = $false
        }
        $ancestorRules = @($ancestorAcl.GetAccessRules(
            $true, $true, [Security.Principal.SecurityIdentifier]
        ))
        foreach ($rule in $ancestorRules) {
            if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
            if ($trustedOwners.Contains($rule.IdentityReference.Value)) { continue }
            if (($rule.PropagationFlags -band
                [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
            $ancestorUntrustedRights = $ancestorUntrustedRights -bor ([int64]$rule.FileSystemRights)
            if (([int64]$rule.FileSystemRights -band $ancestorReplacementRights) -ne 0) {
                $ancestorDeleteSafe = $false
            }
        }
        $ancestor = $ancestor.Parent
    }
} else {
    $ancestorDeleteSafe = $false
}

$secure = $present -and $noReparse -and $trustedOwner -and $trustedAncestorOwner -and
    $noUntrustedWrite -and $protectedBoundary -and $ancestorDeleteSafe
[ordered]@{
    secure = [bool]$secure
    base_path = $root
    worker_script = $workerScript
    protected_boundary = [bool]$protectedBoundary
    ancestor_delete_safe = [bool]$ancestorDeleteSafe
    ancestor_untrusted_rights = [int64]$ancestorUntrustedRights
    trusted_ancestor_owner = [bool]$trustedAncestorOwner
    trusted_owner = [bool]$trustedOwner
    no_reparse = [bool]$noReparse
    no_untrusted_write = [bool]$noUntrustedWrite
    checked_files = [int]@($requiredFiles).Count
} | ConvertTo-Json -Compress
`;
const CODE_TRUST_ENCODED_COMMAND = Buffer.from(CODE_TRUST_SCRIPT, 'utf16le').toString('base64');

export type WorkerHeartbeat = WorkerHeartbeatEnvelopeV2;

export interface WorkerResultEnvelope<T = unknown> {
  id: string;
  duration_ms: number;
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface WorkerSession {
  readonly sessionId: string;
  readonly capability: Buffer;
  readonly queueDir: string;
  queueReady: boolean;
  queueUserSid: string | null;
  launchAttempted: boolean;
  inFlightDispatches: number;
  retired: boolean;
  readonly acceptedResultNonces: Set<string>;
}

interface DispatchOpts {
  timeoutMs?: number;
}

interface QueueTrustProof {
  secure: boolean;
  user_sid: string;
  protected: boolean;
  allowed_sids: string[];
  scope: 'root' | 'leaf';
  queue_root: string;
  queue_dir: string | null;
  owner_sid: string;
  no_reparse: boolean;
  trusted_owner: boolean;
  trusted_ancestor_owner: boolean;
  no_untrusted_write: boolean;
  ancestor_delete_safe: boolean;
}

const QUEUE_TRUST_PROOF_KEYS = Object.freeze([
  'allowed_sids', 'ancestor_delete_safe', 'no_reparse', 'no_untrusted_write',
  'owner_sid', 'protected', 'queue_dir', 'queue_root', 'scope', 'secure',
  'trusted_ancestor_owner', 'trusted_owner', 'user_sid',
]);

interface CodeTrustProof {
  secure: boolean;
  base_path: string;
  worker_script: string;
  protected_boundary: boolean;
  ancestor_delete_safe: boolean;
  ancestor_untrusted_rights: number;
  trusted_ancestor_owner: boolean;
  trusted_owner: boolean;
  no_reparse: boolean;
  no_untrusted_write: boolean;
  checked_files: number;
}

interface LauncherMonitor {
  getFailure: () => ElevatedWorkerError | null;
  deactivate: () => void;
}

let activeSession: WorkerSession | null = null;
let ensureInFlight: Promise<void> | null = null;

function fail(code: string, message: string): never {
  throw new ElevatedWorkerError(code, message);
}

export function getQueueDir(): string {
  return WORKER_QUEUE_ROOT;
}

function createWorkerSession(): WorkerSession {
  const sessionId = randomBytes(RANDOM_ID_BYTES).toString('hex');
  return {
    sessionId,
    capability: randomBytes(WORKER_CAPABILITY_BYTES),
    queueDir: path.join(getQueueDir(), sessionId),
    queueReady: false,
    queueUserSid: null,
    launchAttempted: false,
    inFlightDispatches: 0,
    retired: false,
    acceptedResultNonces: new Set<string>(),
  };
}

function getWorkerSession(): WorkerSession {
  activeSession ??= createWorkerSession();
  return activeSession;
}

function retireWorkerSession(session: WorkerSession): void {
  session.retired = true;
  if (session.inFlightDispatches === 0) session.capability.fill(0);
  if (activeSession === session) activeSession = null;
}

/** Rotation isolates a stale worker while preserving capabilities still in use. */
function rotateWorkerSession(session: WorkerSession): WorkerSession {
  retireWorkerSession(session);
  activeSession = createWorkerSession();
  return activeSession;
}

function acquireWorkerSession(session: WorkerSession): void {
  if (session.retired) fail('E_WORKER_SESSION', 'Worker session was retired before dispatch');
  session.inFlightDispatches += 1;
}

function releaseWorkerSession(session: WorkerSession): void {
  session.inFlightDispatches -= 1;
  if (session.inFlightDispatches < 0) fail('E_WORKER_SESSION', 'Worker session reference underflow');
  if (session.retired && session.inFlightDispatches === 0) session.capability.fill(0);
}

function getHeartbeatPath(session = getWorkerSession()): string {
  return path.join(session.queueDir, '.heartbeat');
}

function getCmdPath(id: string, session = getWorkerSession()): string {
  return path.join(session.queueDir, `${id}.cmd.json`);
}

function getResultPath(id: string, session = getWorkerSession()): string {
  return path.join(session.queueDir, `${id}.result.json`);
}

/** Reads at most maxBytes + 1 from a queue file, even if another process grows it. */
function readBoundedUtf8(filePath: string, maxBytes: number): string {
  const descriptor = openSync(filePath, 'r');
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const count = readSync(descriptor, chunk, 0, chunk.length, null);
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
    }
  } finally {
    closeSync(descriptor);
  }
  if (total > maxBytes) fail('E_ARTIFACT_TOO_LARGE', 'Worker artifact exceeds its size limit');
  const bytes = Buffer.concat(chunks, total);
  try {
    // ignoreBOM preserves U+FEFF so BOM-prefixed JSON remains noncanonical.
    return STRICT_UTF8_DECODER.decode(bytes);
  } catch {
    fail('E_ARTIFACT_ENCODING', 'Worker artifact is not valid UTF-8');
  }
}

/** Publishes a complete command in one same-directory rename. */
function writeAtomicCommand(destination: string, payload: string): void {
  const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
  }
}

/** Runs the fixed read-only proof for the installer root or elevated-created leaf. */
function runQueueTrustProof(
  session: WorkerSession,
  scope: 'root' | 'leaf',
): QueueTrustProof {
  const errorCode = scope === 'root' ? 'E_QUEUE_ROOT_TRUST' : 'E_QUEUE_ACL';
  let output: string;
  try {
    output = execFileSync(PWSH_FALLBACK, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', QUEUE_TRUST_ENCODED_COMMAND,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: createTrustedChildEnvironment({
        [QUEUE_PROOF_SCOPE_ENV]: scope,
        ...(scope === 'leaf' ? { [QUEUE_SESSION_ID_ENV]: session.sessionId } : {}),
      }),
    });
  } catch (error) {
    fail(errorCode, `Worker queue ${scope} trust proof failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(output.trim()) as unknown;
  } catch (error) {
    fail(errorCode, `Worker queue ${scope} trust proof was invalid: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join('\0') !== QUEUE_TRUST_PROOF_KEYS.join('\0')) {
    fail(errorCode, `Worker queue ${scope} trust proof had an invalid shape`);
  }
  const proof = parsed as QueueTrustProof;
  const expected = new Set([proof.user_sid, 'S-1-5-32-544', 'S-1-5-18']);
  if (proof.secure !== true || proof.protected !== true
    || typeof proof.user_sid !== 'string' || !/^S-(?:[0-9]+-)+[0-9]+$/.test(proof.user_sid)
    || !Array.isArray(proof.allowed_sids) || proof.allowed_sids.length !== 3
    || proof.allowed_sids.some((sid) => typeof sid !== 'string' || !expected.has(sid))
    || new Set(proof.allowed_sids).size !== 3
    || proof.scope !== scope
    || proof.queue_root !== WORKER_QUEUE_ROOT
    || proof.queue_dir !== (scope === 'root' ? null : session.queueDir)
    || proof.owner_sid !== WORKER_QUEUE_ROOT_OWNER_SID
    || proof.no_reparse !== true
    || proof.trusted_owner !== true
    || proof.trusted_ancestor_owner !== true
    || proof.no_untrusted_write !== true
    || proof.ancestor_delete_safe !== true) {
    fail(errorCode, `Worker queue ${scope} is not a trusted non-replaceable boundary`);
  }
  return proof;
}

/** Proves the installer-provisioned root before any UAC launch can occur. */
function verifySecureQueueRoot(session: WorkerSession): void {
  const proof = runQueueTrustProof(session, 'root');
  session.queueUserSid = proof.user_sid;
}

/** Proves the leaf created by the elevated worker, then marks it ready for I/O. */
function proveSecureQueueLeaf(session: WorkerSession): void {
  if (!session.queueUserSid) fail('E_QUEUE_ACL', 'Queue root user SID was not proven');
  const proof = runQueueTrustProof(session, 'leaf');
  if (session.queueUserSid !== proof.user_sid) fail('E_QUEUE_ACL', 'Queue user SID changed');
  session.queueReady = true;
}

/** Re-proves a ready leaf immediately before publishing a command. */
function verifySecureQueue(session: WorkerSession): void {
  if (!session.queueReady || !session.queueUserSid) {
    fail('E_QUEUE_ACL', 'Worker queue leaf was not securely created');
  }
  const proof = runQueueTrustProof(session, 'leaf');
  if (session.queueUserSid !== proof.user_sid) fail('E_QUEUE_ACL', 'Queue user SID changed');
}

function verifyTrustedWorkerCode(): void {
  let output: string;
  try {
    output = execFileSync(PWSH_FALLBACK, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', CODE_TRUST_ENCODED_COMMAND,
    ], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15_000,
      env: createTrustedChildEnvironment(),
    });
  } catch (error) {
    fail('E_CODE_TRUST', `Worker code trust verification failed: ${error instanceof Error ? error.message : 'unknown'}`);
  }

  let proof: CodeTrustProof;
  try {
    proof = JSON.parse(output.trim()) as CodeTrustProof;
  } catch (error) {
    fail('E_CODE_TRUST', `Worker code trust proof was invalid: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  if (proof.secure !== true
    || proof.base_path !== WORKER_BASE_PATH
    || proof.worker_script !== WORKER_SCRIPT_PATH
    || proof.protected_boundary !== true
    || proof.ancestor_delete_safe !== true
    || isUnsafeAncestorAccessRule(proof.ancestor_untrusted_rights, 0)
    || proof.trusted_ancestor_owner !== true
    || proof.trusted_owner !== true
    || proof.no_reparse !== true
    || proof.no_untrusted_write !== true
    || proof.checked_files !== WORKER_ACTION_PATHS.length + 1) {
    fail('E_CODE_TRUST', 'ProgramData worker code path is not a trusted immutable boundary');
  }
}

function readHeartbeatForSession(session: WorkerSession): WorkerHeartbeat | null {
  const heartbeatPath = getHeartbeatPath(session);
  if (!existsSync(heartbeatPath)) return null;
  try {
    const raw = readBoundedUtf8(heartbeatPath, WORKER_ARTIFACT_MAX_BYTES);
    return validateHeartbeat(JSON.parse(raw), {
      capability: session.capability,
      sessionId: session.sessionId,
      now: Date.now(),
    });
  } catch {
    return null;
  }
}

export function readHeartbeat(): WorkerHeartbeat | null {
  const session = getWorkerSession();
  return readHeartbeatForSession(session);
}

export function isWorkerAlive(staleAfterMs: number = HEARTBEAT_STALE_MS): boolean {
  const session = getWorkerSession();
  return isWorkerSessionAlive(session, staleAfterMs);
}

function isWorkerSessionAlive(
  session: WorkerSession,
  staleAfterMs: number = HEARTBEAT_STALE_MS,
): boolean {
  const heartbeat = readHeartbeatForSession(session);
  return heartbeat !== null && heartbeat.session_id === session.sessionId
    && Date.now() - heartbeat.issued_at < staleAfterMs;
}

function quoteNativeWindowsArgument(value: string): string {
  let quoted = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === '\\') {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      quoted += '\\'.repeat(backslashes * 2 + 1);
      quoted += '"';
    } else {
      quoted += '\\'.repeat(backslashes);
      quoted += character;
    }
    backslashes = 0;
  }
  quoted += '\\'.repeat(backslashes * 2);
  return `${quoted}"`;
}

/** Builds only non-secret launch coordinates and clears the launcher env copy. */
export function buildLaunchCmd(opts: {
  pwsh: string;
  workerScript: string;
  basePath: string;
  queueRoot: string;
  sessionId: string;
  queueUserSid: string;
}): string {
  const innerArgs = [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', opts.workerScript, '-BasePath', opts.basePath, '-QueueRoot', opts.queueRoot,
    '-SessionId', opts.sessionId, '-QueueUserSid', opts.queueUserSid,
  ].map(quoteNativeWindowsArgument).join(' ');
  return `try { Start-Process -FilePath ${quotePowerShellLiteral(opts.pwsh)} -ArgumentList ${quotePowerShellLiteral(innerArgs)} -Verb RunAs -WindowStyle Hidden } finally { Remove-Item Env:\\${CAPABILITY_ENV} -ErrorAction SilentlyContinue }`;
}

function monitorLauncher(child: ChildProcess): LauncherMonitor {
  let failure: ElevatedWorkerError | null = null;
  let active = true;
  child.once('error', (error) => {
    if (active && failure === null) {
      failure = new ElevatedWorkerError('E_WORKER_LAUNCH', `Worker launcher error: ${error.message}`);
    }
  });
  child.once('exit', (code, signal) => {
    if (active && failure === null && (code !== 0 || signal !== null)) {
      failure = new ElevatedWorkerError(
        'E_WORKER_LAUNCH',
        `Worker launcher exited before authentication (${code ?? signal ?? 'unknown'})`,
      );
    }
  });
  return {
    getFailure: () => failure,
    deactivate: () => { active = false; },
  };
}

function spawnWorker(session: WorkerSession): LauncherMonitor {
  if (!session.queueUserSid) fail('E_QUEUE_ROOT_TRUST', 'Queue root trust was not proven');
  if (session.queueReady) fail('E_QUEUE_ACL', 'Worker queue leaf already exists before elevation');
  // Production is pinned to Windows PowerShell 5.1 because its full framework
  // Directory.CreateDirectory(path, DirectorySecurity) overload creates the
  // leaf with its protected DACL at the directory creation boundary.
  const pwsh = PWSH_FALLBACK;
  const launchCmd = buildLaunchCmd({
    pwsh,
    workerScript: WORKER_SCRIPT_PATH,
    basePath: WORKER_BASE_PATH,
    queueRoot: WORKER_QUEUE_ROOT,
    sessionId: session.sessionId,
    queueUserSid: session.queueUserSid,
  });

  log.info('[elevated-worker] spawning authenticated worker via UAC');
  session.launchAttempted = true;
  let child: ChildProcess;
  try {
    child = spawn(pwsh, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-Command', launchCmd,
    ], {
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
      // A child-only environment copy carries the capability through the UAC launcher.
      env: createTrustedChildEnvironment({
        [CAPABILITY_ENV]: session.capability.toString('base64'),
      }),
    });
  } catch (error) {
    fail('E_WORKER_LAUNCH', `Could not start worker launcher: ${error instanceof Error ? error.message : 'unknown'}`);
  }
  const monitor = monitorLauncher(child);
  child.unref();
  return monitor;
}

/** Proves the elevated-created leaf before reading and authenticating its heartbeat. */
function authenticateReadyWorker(session: WorkerSession): boolean {
  if (!existsSync(getHeartbeatPath(session))) return false;
  if (session.queueReady) verifySecureQueue(session);
  else proveSecureQueueLeaf(session);
  return isWorkerSessionAlive(session);
}

async function ensureWorkerRunningImpl(): Promise<void> {
  let session = getWorkerSession();
  let launcher: LauncherMonitor | null = null;
  try {
    verifySecureQueueRoot(session);
    verifyTrustedWorkerCode();
    if (authenticateReadyWorker(session)) return;

    // One malformed or partially replaced heartbeat is not enough to retire a
    // live session. A second authenticated health probe decides rotation.
    if (session.launchAttempted) {
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_POLL_INTERVAL_MS));
      if (authenticateReadyWorker(session)) return;
      session = rotateWorkerSession(session);
      verifySecureQueueRoot(session);
    }

    launcher = spawnWorker(session);
    const deadline = Date.now() + WORKER_SPAWN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (activeSession === session && authenticateReadyWorker(session)) {
        launcher.deactivate();
        return;
      }
      const launchFailure = launcher.getFailure();
      if (launchFailure) throw launchFailure;
      await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_POLL_INTERVAL_MS));
    }
    fail('E_WORKER_NO_HEARTBEAT', 'Elevated worker did not write a session heartbeat in 60s');
  } catch (error) {
    if (launcher) {
      launcher.deactivate();
    }
    retireWorkerSession(session);
    throw error;
  }
}

export function ensureWorkerRunning(): Promise<void> {
  if (ensureInFlight) return ensureInFlight;
  const run = ensureWorkerRunningImpl();
  ensureInFlight = run;
  const clear = () => { if (ensureInFlight === run) ensureInFlight = null; };
  void run.then(clear, clear);
  return run;
}

function createDispatchEnvelope(
  session: WorkerSession,
  action: WorkerAction,
  params: Readonly<Record<string, unknown>>,
): WorkerCommandEnvelopeV2 {
  return createManualWorkerEnvelope({
    sessionId: session.sessionId,
    capability: session.capability,
    action,
    params,
    issuedAt: Date.now(),
    id: randomBytes(RANDOM_ID_BYTES).toString('hex'),
    nonce: randomBytes(RANDOM_ID_BYTES).toString('hex'),
  });
}

export async function dispatchCommand<T = unknown>(
  action: WorkerAction,
  params: Record<string, unknown>,
  opts: DispatchOpts = {},
): Promise<WorkerResultEnvelope<T>> {
  if (!WORKER_ACTIONS.includes(action)) fail('E_INVALID_ACTION', `Unknown worker action: ${action}`);

  // Snapshot before UAC, then issue a fresh 30-second envelope only after the
  // worker heartbeat and final ACL proof. Slow consent cannot stale a command.
  const frozenParams = snapshotWorkerActionParams(action, params);
  await ensureWorkerRunning();
  const session = getWorkerSession();
  acquireWorkerSession(session);
  try {
    verifySecureQueue(session);
    const envelope = createDispatchEnvelope(session, action, frozenParams);

    const cmdPath = getCmdPath(envelope.id, session);
    const resultPath = getResultPath(envelope.id, session);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
    writeAtomicCommand(cmdPath, JSON.stringify(envelope));

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(resultPath)) {
        let raw = '';
        try {
          raw = readBoundedUtf8(resultPath, WORKER_ARTIFACT_MAX_BYTES);
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_INTERVAL_MS));
          try { raw = readBoundedUtf8(resultPath, WORKER_ARTIFACT_MAX_BYTES); } catch {
            fail('E_BAD_RESULT', `Could not read result: ${error instanceof Error ? error.message : 'unknown'}`);
          }
        }
        try { rmSync(resultPath, { force: true }); } catch { /* best effort */ }
        try { rmSync(cmdPath, { force: true }); } catch { /* worker normally removes it */ }
        try {
          const validated = validateResultEnvelope(JSON.parse(raw), {
            capability: session.capability,
            sessionId: session.sessionId,
            commandId: envelope.id,
            action,
            now: Date.now(),
            acceptedNonces: session.acceptedResultNonces,
          });
          return {
            id: validated.id,
            duration_ms: validated.duration_ms,
            success: validated.success,
            ...(validated.success ? { data: validated.data as T } : { error: validated.error }),
          };
        } catch (error) {
          fail('E_BAD_RESULT', `Could not authenticate result: ${error instanceof Error ? error.message : 'unknown'}`);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, RESULT_POLL_INTERVAL_MS));
    }

    try { rmSync(cmdPath, { force: true }); } catch { /* best effort */ }
    fail('E_CMD_TIMEOUT', `Worker did not return a result for ${action} within ${timeoutMs}ms`);
  } finally {
    releaseWorkerSession(session);
  }
}

function assertTestRuntime(): void {
  if (process.env.NODE_ENV !== 'test') fail('E_TEST_ONLY', 'Worker test hook is unavailable');
}

function resetWorkerSessionForTests(): void {
  assertTestRuntime();
  if (activeSession) activeSession.capability.fill(0);
  activeSession = null;
  ensureInFlight = null;
}

export const _testing = {
  HEARTBEAT_STALE_MS,
  WORKER_SPAWN_TIMEOUT_MS,
  DEFAULT_CMD_TIMEOUT_MS,
  CAPABILITY_ENV,
  WORKER_QUEUE_ROOT,
  WORKER_QUEUE_ROOT_OWNER_SID,
  QUEUE_USER_ACL_MODEL,
  WORKER_ACTION_CONTRACTS,
  getHeartbeatPath,
  getCmdPath,
  getResultPath,
  canonicalizeJson,
  signEnvelopeFields,
  validateEnvelope,
  isUnsafeAncestorAccessRule,
  readBoundedUtf8ForTests: (filePath: string, maxBytes: number) => {
    assertTestRuntime();
    return readBoundedUtf8(filePath, maxBytes);
  },
  resetWorkerSessionForTests,
  getWorkerSessionForTests: () => {
    assertTestRuntime();
    const session = getWorkerSession();
    return {
      sessionId: session.sessionId,
      queueDir: session.queueDir,
      capability: Buffer.from(session.capability),
    };
  },
};
