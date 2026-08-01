// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (relativePath: string): string => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

const PRIVILEGED_ROOT = 'C:\\Program Files\\PCDoctor Workbench\\privileged';
const WORKER_FILES = [
  'Elevated-Worker.ps1',
  'Set-ServiceStartup.ps1',
  'Stop-Service.ps1',
  'Start-Service.ps1',
  'Restart-Service.ps1',
  'Kill-Process.ps1',
  'Set-ProcessPriority.ps1',
  'Set-ProcessAffinity.ps1',
  'Suspend-Process.ps1',
  'Resume-Process.ps1',
] as const;

describe('installer-provisioned Task 4 trust boundaries', () => {
  const builderConfig = read('electron-builder.yml');
  const installer = read('scripts/installer.nsh');
  const provisioner = read('powershell/Install-WorkerBoundary.ps1');
  const programDataInitializer = read('powershell/Initialize-ProgramDataRoot.ps1');
  const applyTieredAcl = read('powershell/Apply-TieredAcl.ps1');
  const cleanup = read('powershell/Cleanup-StaleWorkerSessions.ps1');
  const workerSource = read('src/main/elevatedWorker.ts');
  const scriptRunner = read('src/main/scriptRunner.ts');
  const upgradeTool = read('powershell/Upgrade-Tool.ps1');
  const checkToolUpdates = read('powershell/Check-ToolUpdates.ps1');
  const installedAclVerifier = read('powershell/Verify-InstalledAcl.ps1');

  it('uses one fixed administrator-protected Program Files payload with the exact worker plus nine actions', () => {
    expect(workerSource).toContain(PRIVILEGED_ROOT.replaceAll('\\', '\\\\'));
    expect(workerSource).not.toContain('const WORKER_BASE_PATH = PCDOCTOR_ROOT');
    for (const fileName of WORKER_FILES) {
      expect(provisioner).toContain(fileName);
      expect(workerSource).toContain(fileName);
    }
    const payloadSources = [...provisioner.matchAll(/Source\s*=\s*'([^']+\.ps1)'/g)].map(match => match[1]);
    expect(payloadSources).toHaveLength(10);
    expect(new Set(payloadSources.map(value => path.win32.basename(value)))).toEqual(new Set(WORKER_FILES));
    expect(WORKER_FILES).toHaveLength(10);
  });

  it('provisions the fixed queue owner and protected no-write ordinary-user ACL before worker use', () => {
    expect(provisioner).toContain('C:\\ProgramData\\PCDoctorWorkerQueue');
    expect(provisioner).toContain('S-1-5-32-544');
    expect(provisioner).toContain('S-1-5-18');
    expect(provisioner).toContain('S-1-5-32-545');
    expect(provisioner).toContain('SetAccessRuleProtection($true, $false)');
    expect(provisioner).toContain('[Security.AccessControl.FileSystemRights]::ReadAndExecute');
    expect(provisioner).toContain("Set-ProtectedDirectory -Path $queueRoot -AllowUsersRead $true");
    expect(provisioner).toContain("E_SOURCE_UNTRUSTED: expected '$expectedSourceRoot'");
    const usersRule = provisioner.match(/\$usersSid,[\s\S]{0,120}?FileSystemRights\]::([A-Za-z]+)/g) ?? [];
    expect(usersRule.length).toBeGreaterThan(0);
    expect(usersRule.every(rule => rule.includes('ReadAndExecute'))).toBe(true);
    expect(provisioner).toContain("'C:\\Program Files'");
    expect(provisioner).toContain("'C:\\Program Files\\PCDoctor Workbench'");
    expect(provisioner).toContain("'C:\\ProgramData'");
    expect(provisioner).toContain('E_ANCESTOR_REPARSE');
  });

  it('uses self-contained SHA-256 and a fixed System32 PowerShell for cleanup', () => {
    expect(provisioner).toContain('[Security.Cryptography.SHA256]::Create()');
    expect(provisioner).not.toContain('Get-FileHash');
    expect(provisioner).toContain("'WindowsPowerShell\\v1.0\\powershell.exe'");
    expect(provisioner).toMatch(/&\s+\$powerShellPath\s+-NoProfile/);
  });

  it('has no runtime fallback to ProgramData or a per-user bundle for privileged code', () => {
    expect(workerSource).not.toMatch(/PCDOCTOR_ROOT[\s\S]{0,120}Elevated-Worker\.ps1/);
    expect(workerSource).not.toMatch(/process\.resourcesPath[\s\S]{0,120}Elevated-Worker\.ps1/);
    expect(workerSource).not.toMatch(/LOCALAPPDATA[\s\S]{0,120}Elevated-Worker\.ps1/i);
  });

  it('anchors elevated installer inputs in a fixed per-machine Program Files install', () => {
    expect(builderConfig).toMatch(/nsis:[\s\S]*?perMachine:\s*true/);
    expect(builderConfig).toMatch(/nsis:[\s\S]*?allowToChangeInstallationDirectory:\s*false/);
  });

  it('executes privileged installer helpers only from the fixed Program Files bundle', () => {
    expect(installer).not.toMatch(/ExecWait\s+'powershell\.exe\b/i);
    expect(installer).toContain('$SYSDIR\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(installer).toContain('-File "$INSTDIR\\resources\\powershell\\Install-WorkerBoundary.ps1" -Mode Install');
    expect(installer).toContain('-File "$INSTDIR\\resources\\powershell\\Register-All-Tasks.ps1"');
    expect(installer).toContain('-File "$INSTDIR\\resources\\powershell\\Unregister-All-Tasks.ps1" -IncludeLegacy');
    expect(installer).toContain('-File "$INSTDIR\\resources\\powershell\\Install-WorkerBoundary.ps1" -Mode Uninstall');
    expect(installer).not.toMatch(/-File "C:\\ProgramData\\PCDoctor\\(?:Install-WorkerBoundary|Register-All-Tasks|Unregister-All-Tasks)\.ps1"/i);
    expect(installer).toContain('StrCmp $INSTDIR "C:\\Program Files\\PCDoctor Workbench"');
    expect(scriptRunner).toContain('TRUSTED_PACKAGED_POWERSHELL_ROOT');
    expect(scriptRunner).toMatch(/runElevatedPowerShellScript[\s\S]*?resolveElevatedScriptPath\(relativeScriptPath\)/);
  });

  it('keeps nested elevated script calls inside the trusted bundle', () => {
    expect(upgradeTool).not.toContain("-File 'C:\\ProgramData\\PCDoctor\\Check-ToolUpdates.ps1'");
    expect(upgradeTool).toContain("Join-Path $PSScriptRoot 'Check-ToolUpdates.ps1'");
    expect(upgradeTool).toContain("'WindowsPowerShell\\v1.0\\powershell.exe'");
    expect(upgradeTool).toContain('Microsoft.DesktopAppInstaller');
    expect(upgradeTool).toContain('WindowsPowerShell\\v1.0\\Modules\\Appx\\Appx.psd1');
    expect(upgradeTool).toContain('Appx\\Get-AppxPackage');
    expect(upgradeTool).toContain('Microsoft.PowerShell.Security\\Get-AuthenticodeSignature');
    expect(upgradeTool).not.toMatch(/^\s*Get-AppxPackage\b/m);
    expect(upgradeTool).not.toMatch(/^\s*Get-AuthenticodeSignature\b/m);
    expect(upgradeTool).not.toMatch(/Get-Command\s+winget|&\s+winget\b/i);
    expect(upgradeTool).toMatch(/&\s+\$winget\s+upgrade\b/);
    expect(upgradeTool).toContain('-TrustedWingetPath $winget');
    expect(checkToolUpdates).toContain("[string]$TrustedWingetPath = ''");
    expect(checkToolUpdates).toMatch(/&\s+\$winget\s+upgrade\b/);
    expect(checkToolUpdates).not.toMatch(/&\s+winget\b/i);
  });

  it('establishes a non-reparse protected ProgramData root before copy or recursion', () => {
    expect(installer).toContain('-File "$INSTDIR\\resources\\powershell\\Initialize-ProgramDataRoot.ps1"');
    const initializeAt = installer.indexOf('Initialize-ProgramDataRoot.ps1');
    expect(initializeAt).toBeGreaterThan(-1);
    expect(initializeAt).toBeLessThan(installer.indexOf('Copy-Item'));
    expect(installer).not.toMatch(/takeown\.exe[^\r\n]*\/r/i);
    expect(installer).not.toMatch(/icacls\.exe[^\r\n]*\/reset[^\r\n]*\/T/i);
    expect(programDataInitializer).toContain('C:\\ProgramData\\PCDoctor');
    expect(programDataInitializer).toContain('[IO.Directory]::CreateDirectory($programDataRoot, $rootSecurity)');
    expect(programDataInitializer).toContain('E_PROGRAMDATA_REPARSE');
    expect(programDataInitializer).toContain('SetAccessRuleProtection($true, $false)');
    expect(programDataInitializer).toContain('Get-ChildItem -LiteralPath $current -Force');
    expect(programDataInitializer).toContain('CreateFileW');
    expect(programDataInitializer).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
    expect(programDataInitializer).toContain('SetKernelObjectSecurity');
    expect(provisioner).toContain('Assert-TrustedExistingDirectory');
    expect(provisioner).toContain('[IO.Directory]::CreateDirectory($fullPath, $security)');
    expect(provisioner).toContain('OpenDirectoryForSecurity');
    expect(provisioner).toContain('FILE_FLAG_OPEN_REPARSE_POINT');
    expect(provisioner).toContain('ReadOwnerAndDacl');
    expect(provisioner).toContain('ApplyOwnerAndDacl($handle, $descriptor)');
    expect(provisioner).not.toContain('[IO.Directory]::SetAccessControl');
    expect(installer).toMatch(/Copy-Item[^\r\n']*'\s+\$0[\s\S]{0,180}?Abort/);
    expect(installer.lastIndexOf('PCDoctorApplyAcl "C:\\ProgramData\\PCDoctor" A root')).toBeGreaterThan(
      installer.lastIndexOf(' B recurse'),
    );
    expect(applyTieredAcl).toContain('E_ACL_REPARSE');
    expect(applyTieredAcl).toContain('E_ACL_TRAVERSAL_UNTRUSTED');
    const filePassAt = applyTieredAcl.indexOf('foreach ($filePath in $files)');
    const bottomUpSortAt = applyTieredAcl.indexOf('$directoriesBottomUp =');
    const directoryPassAt = applyTieredAcl.indexOf('foreach ($directoryPath in $directoriesBottomUp)');
    const rootAclAt = applyTieredAcl.indexOf('Set-PCDoctorDirectoryAcl -DirectoryPath $normalizedRoot');
    expect(filePassAt).toBeGreaterThan(-1);
    expect(bottomUpSortAt).toBeGreaterThan(filePassAt);
    expect(directoryPassAt).toBeGreaterThan(bottomUpSortAt);
    expect(rootAclAt).toBeGreaterThan(directoryPassAt);
    expect(applyTieredAcl.slice(bottomUpSortAt, directoryPassAt)).toContain('-Descending');
    expect(applyTieredAcl.slice(directoryPassAt, rootAclAt)).toContain('continue');
    const filePass = applyTieredAcl.slice(filePassAt, rootAclAt);
    expect(filePass).toContain("$fileUsersPermission = 'M'");
    for (const databaseFile of ['workbench.db', 'workbench.db-wal', 'workbench.db-shm']) {
      expect(filePass).toContain(`'${databaseFile}'`);
    }
  });

  it('fails closed on every ACL application and leaves Defender policy untouched', () => {
    expect(installer).not.toMatch(/(?:Add|Remove)-MpPreference\s+-ExclusionPath/i);
    expect(installer).toContain('!macro PCDoctorApplyAcl');
    expect(installer.match(/!insertmacro PCDoctorApplyAcl/g)).toHaveLength(11);
    expect(installer).toMatch(/!macro PCDoctorApplyAcl[\s\S]{0,500}?ExecWait[^\r\n]*\$0[\s\S]{0,220}?Abort/);
    expect(installer).toMatch(/ExecWait[^\r\n]*workbench\.db-wal[^\r\n]*\$0[\s\S]{0,220}?Abort/);
    for (const databaseFile of ['workbench.db', 'workbench.db-wal', 'workbench.db-shm']) {
      expect(installer).toContain(`${databaseFile} -PathType Leaf`);
    }
    expect(installer).toMatch(/Verify-InstalledAcl\.ps1[^\r\n']*'\s+\$0[\s\S]{0,220}?Abort/);
    expect(installedAclVerifier).toContain("Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1");
    expect(installedAclVerifier).toContain("'icacls.exe'");
    expect(installedAclVerifier).toContain("@('workbench.db', 'workbench.db-wal', 'workbench.db-shm')");
    expect(installedAclVerifier).toContain('$failures.Add($msg)');
    expect(installedAclVerifier).not.toMatch(/^\s*Import-Module\s+Microsoft\.PowerShell\.Security\b/m);
    expect(installedAclVerifier).not.toMatch(/^\s*\$?\w*\s*=\s*\(icacls\b/m);
  });

  it('uninstalls only the exact fixed payload and queue roots and exposes stale-leaf cleanup', () => {
    expect(installer).toContain('Install-WorkerBoundary.ps1" -Mode Uninstall');
    expect(installer).not.toMatch(/RMDir\s+\/r/i);
    expect(provisioner).toContain("Remove-ExactBoundary -Path $privilegedRoot -ExpectedPath 'C:\\Program Files\\PCDoctor Workbench\\privileged'");
    expect(provisioner).toContain("Remove-ExactBoundary -Path $queueRoot -ExpectedPath 'C:\\ProgramData\\PCDoctorWorkerQueue'");
    expect(provisioner).toContain('Refusing reparse-point removal target');
    expect(provisioner).toContain('Cleanup-StaleWorkerSessions.ps1');
    expect(cleanup).toContain("$item.Name -cnotmatch '^[0-9a-f]{32}\\z'");
    expect(cleanup).toContain('$item.LastWriteTimeUtc -gt $cutoff');
    expect(cleanup).toContain('Remove-Item -LiteralPath $fullLeaf -Recurse -Force');
    const uninstall = installer.slice(installer.indexOf('!macro customUnInstall'));
    expect(uninstall).toMatch(/Unregister-All-Tasks\.ps1[^\r\n']*'\s+\$0/);
    expect(uninstall).toMatch(/Install-WorkerBoundary\.ps1[^\r\n']*'\s+\$0/);
    expect(uninstall.match(/\bAbort\b/g)).toHaveLength(3);
  });

  it('ships a disabled installed-smoke handoff that requires explicit authorization', () => {
    const smoke = read('scripts/test-installed-worker-boundary.ps1');
    expect(smoke).toContain('AuthorizedInstalledSmoke');
    expect(smoke).toContain('E_INSTALLED_SMOKE_NOT_AUTHORIZED');
    expect(smoke).toContain('PCDoctorWorkerQueue');
    expect(smoke).toContain(PRIVILEGED_ROOT);
    expect(smoke).toContain('$expectedRelativePaths');
    expect(smoke).toContain('Unexpected privileged payload');
    expect(smoke).toContain('Inherited DACL');
    expect(smoke).toContain('Users ACE is writable');
    expect(provisioner).toContain('E_UNEXPECTED_PRIVILEGED_PAYLOAD');
  });
});
