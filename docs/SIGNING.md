# Code Signing

PCDoctor Workbench uses a **self-signed Authenticode certificate** for release binaries. This is a deliberate trade-off: commercial EV certs cost hundreds of dollars a year and are gated on business registration, which doesn't make sense for a personal-use tool. Self-signing gives us the one property that actually matters for an auto-updating app — **integrity between release and update**.

## What self-signing buys us

`electron-updater` verifies every downloaded installer against `win.publisherName` in `package.json`. If an attacker compromises the GitHub account and pushes a replacement installer, the replacement must be signed by the same PFX (which never touches the GitHub account) or the client rejects the update. Without signing, an account compromise is a full supply-chain compromise.

## What self-signing doesn't buy us

- No SmartScreen reputation. Fresh installs still show *"Windows protected your PC"* until enough users have installed the app.
- No EV-signed-driver privileges (not needed here).
- No revocation infrastructure. If the PFX leaks, rotate manually.

## Setup (one-time, per-developer)

```powershell
# From the repo root, in PowerShell
pwsh -File scripts/generate-signing-cert.ps1
```

This:

1. Creates a self-signed cert in `Cert:\CurrentUser\My` valid for 5 years.
2. Exports it to `build/signing/pcdoctor-signing.pfx` (gitignored — **never commit the PFX**).
3. Prompts for a password to protect the private key on disk.

Then set two environment variables (per-session, or persist via `[Environment]::SetEnvironmentVariable(...)`):

```powershell
$env:CSC_LINK = 'build/signing/pcdoctor-signing.pfx'
$env:CSC_KEY_PASSWORD = '<the password you set during generation>'
```

`electron-builder` picks both up automatically on the next `npm run package`.

## Forking the repo

If you fork PCDoctor Workbench:

1. Run `scripts/generate-signing-cert.ps1` with your own `-Subject`.
2. Update `electron-builder.yml` → `win.signtoolOptions.publisherName` (when you activate it) to match the CN of your new cert exactly.
3. Update `electron-builder.yml` → `publish.owner` and `publish.repo` to your fork's coordinates so your fork publishes to **your** GitHub Releases, not upstream. Example:

   ```yaml
   publish:
     - provider: github
       owner: alice-smith       # your GitHub username/org
       repo: pcdoctor-workbench # your fork name
       releaseType: release
   ```

   (An earlier v2.4.6 draft tried to make this env-driven via `${env.GH_OWNER:-gregpa}`. electron-builder's YAML interpolation doesn't support bash-style defaults, and it baked the literal template string into `app-update.yml`, 404-ing every update check. Editing the YAML directly is simpler and works.)

4. Update the `appId` in `electron-builder.yml` so your fork doesn't collide with upstream installs on the same machine.

Your fork will then have an independent signing chain and update feed. Releases signed by your PFX update cleanly for your users; upstream's releases and signatures are never referenced.

## Rotating the cert

If the PFX ever leaks or you want to bump key length:

1. Generate a new cert with `scripts/generate-signing-cert.ps1`.
2. Ship one transition release where both the old and new publisher names are accepted (edit `win.publisherName` to match only the new cert — previous versions are already installed, they don't re-verify).
3. Delete the old cert from `Cert:\CurrentUser\My`.

There is no revocation; existing installs trust any binary signed by the old PFX until they upgrade past the transition release.

## Debugging

- `signtool.exe verify /pa /v <installer.exe>` — confirms the installer is signed.
- `Get-AuthenticodeSignature <installer.exe>` — PowerShell version, shows subject + thumbprint.
- If `electron-updater` logs `publisherName mismatch`, double-check that the PFX's CN exactly matches `win.publisherName` (case-sensitive, trailing whitespace counts).
