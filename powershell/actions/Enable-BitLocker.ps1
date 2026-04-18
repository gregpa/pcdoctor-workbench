param([string]$Drive = 'C:', [switch]$DryRun, [switch]$JsonOutput)
$ErrorActionPreference = 'Stop'
trap { $e = @{code='E_PS_UNHANDLED';message=$_.Exception.Message} | ConvertTo-Json -Compress; Write-Host "PCDOCTOR_ERROR:$e"; exit 1 }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
if ($DryRun) { @{success=$true;dry_run=$true;duration_ms=0;message='DryRun'}|ConvertTo-Json -Compress; exit 0 }

# BitLocker enable is interactive normally; we invoke with TPM + recovery-password protectors
try {
    Enable-BitLocker -MountPoint $Drive -EncryptionMethod XtsAes256 -UsedSpaceOnly -TpmProtector -ErrorAction Stop
    Add-BitLockerKeyProtector -MountPoint $Drive -RecoveryPasswordProtector -ErrorAction SilentlyContinue | Out-Null
    $info = Get-BitLockerVolume -MountPoint $Drive
    $sw.Stop()
    @{
        success = $true
        duration_ms = $sw.ElapsedMilliseconds
        drive = $Drive
        status = "$($info.VolumeStatus)"
        recovery_key = "Stored on the drive - save it via: manage-bde -protectors -get $Drive"
        message = "BitLocker encryption started on $Drive"
    } | ConvertTo-Json -Compress
} catch {
    # Pass through the actual error message rather than a trap-generic one
    throw "BitLocker enable failed: $($_.Exception.Message). May require Admin + TPM enabled in BIOS."
}
exit 0
