<#
.SYNOPSIS
    Generate a self-signed Authenticode code-signing certificate for
    PCDoctor Workbench releases. One-time setup per machine.
.DESCRIPTION
    PCDoctor Workbench is intentionally not commercially signed — the
    cost structure doesn't make sense for a personal-use tool. But
    shipping unsigned installers leaves a real supply-chain gap: a
    future compromise of the GitHub account could push a replacement
    installer that electron-updater silently accepts, because unsigned
    auto-update has no integrity check beyond the SHA hash in latest.yml
    (which the attacker also controls).

    Self-signing fixes this. electron-updater compares the signature's
    publisherName against package.json's win.publisherName field and
    rejects mismatches, so an attacker would need the .pfx AND its
    password to ship a valid update. Windows still shows the SmartScreen
    warning on first install, but every subsequent update is verified.

    This script:
      1. Creates a self-signed cert in the user's CurrentUser\My store
      2. Exports it to `.\build\signing\pcdoctor-signing.pfx` (gitignored)
      3. Prints the publisher name and thumbprint for electron-builder.yml
      4. Prompts you to save the password in an env var (CSC_KEY_PASSWORD)

    The resulting .pfx is used by electron-builder at package time via:
        env:
          CSC_LINK=build/signing/pcdoctor-signing.pfx
          CSC_KEY_PASSWORD=<your password>

    Forkers: run this script once, set your own CSC_KEY_PASSWORD env var,
    and update publisherName in package.json to match your cert subject.
    Your releases will be independently signed and won't inherit Greg's
    trust chain.
.PARAMETER Subject
    CN in the cert subject. Default "Greg Pajak (PCDoctor Workbench)".
    Override for a fork: e.g. "Alice Smith (PCDoctor Workbench)".
.PARAMETER ValidityYears
    How long the cert is valid. Default 5 years. The cert is pinned to
    publisherName, not expiry, so extending this is safe.
.PARAMETER OutDir
    Where to write the .pfx. Default ./build/signing/. Must be in
    .gitignore — never commit the PFX.
#>
param(
    [string]$Subject = 'Greg Pajak (PCDoctor Workbench)',
    [int]$ValidityYears = 5,
    [string]$OutDir = (Join-Path $PSScriptRoot '..\build\signing')
)

$ErrorActionPreference = 'Stop'

Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  PCDoctor Workbench - Signing Cert Generator" -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Subject:      CN=$Subject"
Write-Host "Validity:     $ValidityYears years"
Write-Host "Output dir:   $OutDir"
Write-Host ""

if (-not (Test-Path $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
}

$pfxPath = Join-Path $OutDir 'pcdoctor-signing.pfx'
if (Test-Path $pfxPath) {
    Write-Host "WARNING: $pfxPath already exists." -ForegroundColor Yellow
    $ans = Read-Host "Overwrite? (y/N)"
    if ($ans -ne 'y' -and $ans -ne 'Y') {
        Write-Host "Aborted." -ForegroundColor Red
        exit 1
    }
}

Write-Host "Step 1/3: Creating self-signed certificate..." -ForegroundColor Green
$cert = New-SelfSignedCertificate `
    -Subject "CN=$Subject" `
    -Type CodeSigningCert `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears($ValidityYears) `
    -CertStoreLocation 'Cert:\CurrentUser\My'

Write-Host "  Thumbprint: $($cert.Thumbprint)"
Write-Host "  Expires:    $($cert.NotAfter)"
Write-Host ""

Write-Host "Step 2/3: Set an export password for the PFX." -ForegroundColor Green
Write-Host "  This password protects the private key on disk."
Write-Host "  You will need to set CSC_KEY_PASSWORD=<this password> when building."
Write-Host ""
$password = Read-Host -AsSecureString "PFX password (min 8 chars)"

Export-PfxCertificate `
    -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" `
    -FilePath $pfxPath `
    -Password $password | Out-Null

Write-Host "  Exported: $pfxPath"
Write-Host ""

Write-Host "Step 3/3: Wire-up instructions" -ForegroundColor Green
Write-Host ""
Write-Host "  1. Confirm build/signing/ is in .gitignore (never commit the PFX)."
Write-Host ""
Write-Host "  2. Update package.json 'build.win.publisherName' to exactly:"
Write-Host ("     " + $Subject) -ForegroundColor Cyan
Write-Host ""
Write-Host "  3. Set these env vars before 'npm run package' (for this session):" -ForegroundColor White
Write-Host ""
Write-Host "     `$env:CSC_LINK = 'build/signing/pcdoctor-signing.pfx'" -ForegroundColor Gray
Write-Host "     `$env:CSC_KEY_PASSWORD = '<the password you just entered>'" -ForegroundColor Gray
Write-Host ""
Write-Host "     For permanent use, set them in your user profile via:"
Write-Host "     [Environment]::SetEnvironmentVariable('CSC_LINK', '...', 'User')"
Write-Host ""
Write-Host "  4. electron-builder picks these up automatically when packaging."
Write-Host ""
Write-Host "Done." -ForegroundColor Green
