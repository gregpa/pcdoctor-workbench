# Developer Warnings

Permanent record of anti-patterns that broke PCDoctor Workbench in production.
Read this BEFORE touching `scripts/installer.nsh`, `powershell/Apply-TieredAcl.ps1`,
`powershell/Repair-ScriptAcls.ps1`, or any other ACL-related code.

## 1. NEVER use `icacls /grant:r "SID:(OI)(CI)PERM" /T` on a mixed dir/file tree

### The bug

`icacls <root> /inheritance:r /grant:r "SID:(OI)(CI)PERM" /T` applied recursively
to a tree that contains both directories and files **fails silently on FILE
children**. The `(OI)(CI)` tokens are directory-only inheritance flags (Object
Inherit + Container Inherit). `icacls /grant:r` rejects the ACE on files because
the flags are invalid there. But `icacls /inheritance:r` still succeeds in
stripping inherited ACEs from those same files. End state: tree-wide files with
**zero ACEs** — unreadable even by admin.

### How it bit us

| Version | Zero-ACE file count | User impact |
| --- | --- | --- |
| v2.4.6 | 83 | Elevated action scripts (`Update-HostsFromStevenBlack`, `Enable-PUAProtection`, etc.) fail with generic "Script exited with code 1" |
| v2.4.7 | 14 (in `security/`) | Security sidebar page broken |
| v2.4.8 | 787 | Dashboard fails to load — `EPERM on reports/latest.json` |

Three rebuilds shipped in one day, each requiring Greg to manually hotfix his
installed app via `takeown + icacls /reset + per-dir grants`.

### The fix

`powershell/Apply-TieredAcl.ps1` enumerates directories and files separately
and applies the correct flags to each:

- **Directories** get `(OI)(CI)PERM` so the ACE propagates to their children.
- **Files** get `PERM` with no inheritance flags (the flags are meaningless
  on leaves anyway).

Both `installer.nsh` and `scripts/test-installer-acl.ps1` call
`Apply-TieredAcl.ps1`. If you change the ACL logic, change it there — not by
patching inline icacls calls in either caller.

## 2. NEVER ship an installer rebuild without running the pre-ship gate

### The rule

Before `npx @electron/rebuild` + `npm run package`, run:

```powershell
# Elevated PowerShell
& "C:\dev\pcdoctor-workbench\scripts\test-installer-acl.ps1"
```

Require the output to include:

```
[PASS] All files have healthy ACLs. Safe to ship.
```

If `[FAIL]`, iterate on `Apply-TieredAcl.ps1` or the harness until PASS. Do not
rebuild meanwhile.

### What the harness does

1. Creates a sandbox at `%TEMP%/pcdoctor-acl-sandbox-<random>/`
2. Populates it with the same tree layout as `C:\ProgramData\PCDoctor\`
3. Corrupts ~15% of files to zero-ACE DACLs (simulates upgrade-install state)
4. Runs the exact installer ACL sequence via `Apply-TieredAcl.ps1`
5. Verifies every file has a non-empty DACL
6. Exits 1 if any file fails, 0 if all healthy

### Why this rule exists

v2.4.6, v2.4.7, and v2.4.8 all shipped with installer bugs because the ACL
logic was validated only by mental dry-run. Mental dry-runs repeatedly missed
the `(OI)(CI)`-on-files failure mode. The harness catches it empirically in
~5 seconds.

## 3. PowerShell elevated arg binding — use inline tokens, not array splat

### The bug

The `runElevatedPowerShellScript` path in `src/main/scriptRunner.ts` generates
a command string that gets passed to an elevated pwsh via `Start-Process -Verb
RunAs`. The original implementation used either inline array expression
(`& $script @('-JsonOutput')`) or variable array splat (`$arr = @('-JsonOutput');
& $script @arr`). **Both bind switches positionally**, not as switches.

`@('-JsonOutput')` as an inline expression passes a single array argument,
coerced to string `'-JsonOutput'`, bound to the first `[string]` param. Seen
in production on `Update-HostsFromStevenBlack.ps1`:

```
$SourceUrl = '-JsonOutput'  # bound positionally
Invoke-WebRequest -Uri '-JsonOutput'  # → "No such host is known. (-jsonoutput:80)"
```

Array splat `$arr = @(...); & $script @arr` has the SAME bug — PowerShell's
array splat passes elements positionally regardless of `-` prefix. Only
**hashtable splat** `@{JsonOutput = $true}` binds switches by name. We don't
know switch-vs-value at generation time in the TS code, so hashtable splat
isn't viable.

### The fix

Emit each arg as an inline literal token:

```typescript
const argsInline = args.map(a => {
  // Parameter/switch name — pass literal so PowerShell's `&` operator
  // recognizes the `-` prefix at invocation time.
  if (/^-[A-Za-z_][\w]*$/.test(a)) return a;
  // Value — single-quote escape (doubled-quote is PS escape for ').
  return `'${a.replace(/'/g, "''")}'`;
}).join(' ');

// Result: `& '...script.ps1' -JsonOutput -SourceUrl 'https://...'`
```

This was verified empirically in `C:\dev\pcdoctor-workbench` with a test
function that a harness could replicate. Don't refactor this to "something
cleaner" without re-running the same test. It matters.

## 4. Always match installer.nsh against the test harness

The installer and harness MUST call the same helper scripts with the same args.
If you change one, change the other. A drift between them means the test
doesn't reflect what ships.

Current shared helpers:

- `powershell/Apply-TieredAcl.ps1` — core tier-A/tier-B ACL logic
- `powershell/Repair-ScriptAcls.ps1` — zero-ACE safety-net scanner
- `powershell/Heal-InstallAcls.ps1` — runtime self-heal (main.ts startup)

If any of these change, re-run:

```powershell
& "C:\dev\pcdoctor-workbench\scripts\test-installer-acl.ps1"
```

## 5. NEVER re-enable inheritance tree-wide on a locked-down install

Old code in `powershell/Sync-ScriptsFromBundle.ps1:149` had:

```powershell
& icacls $DestDir '/inheritance:e' '/T' '/C' '/Q' | Out-Null
```

This re-enables inheritance on the ENTIRE `C:\ProgramData\PCDoctor\` tree. It
undoes the installer's lockdown by propagating ProgramData's default
`Users:(I)(M)` back onto every script — reopening the "bring-your-own-elevator"
pathway where malware running as the user can swap a PS script and have the
next UAC-elevated action run the replacement.

Fixed in v2.4.9: scope `/inheritance:e` to just the newly-copied files inside
the Sync-ScriptsFromBundle copy loop. Never run tree-wide `/inheritance:e`.

## 6. Defender races icacls — exclusion + sleep, don't optimise away

Windows Defender's real-time scan holds files open briefly during scan. If
`icacls` hits a file that Defender has locked, the grant silently fails while
`/inheritance:r` still succeeds (see warning #1).

The installer adds a Defender exclusion (`Add-MpPreference -ExclusionPath`)
and sleeps 2 seconds before running any icacls. **Do not remove the sleep or
the exclusion.** Exclusion-add is not instantaneous — in-flight scans don't
abort. The 2-second window is what lets Defender release existing handles
before we touch ACLs.

If you find yourself wanting to speed up the installer, find a different
second to cut. Keep the Defender pause.

## References

- [`scripts/installer.nsh`](../scripts/installer.nsh) — the NSIS install hook
- [`scripts/test-installer-acl.ps1`](../scripts/test-installer-acl.ps1) — pre-ship gate
- [`powershell/Apply-TieredAcl.ps1`](../powershell/Apply-TieredAcl.ps1) — shared ACL logic
- [`powershell/Heal-InstallAcls.ps1`](../powershell/Heal-InstallAcls.ps1) — runtime self-heal
- [`powershell/Repair-ScriptAcls.ps1`](../powershell/Repair-ScriptAcls.ps1) — zero-ACE safety net
- [`src/main/scriptRunner.ts`](../src/main/scriptRunner.ts) — elevated arg-emission logic
- [`src/main/main.ts`](../src/main/main.ts) — startup self-heal hook (line ~231)
