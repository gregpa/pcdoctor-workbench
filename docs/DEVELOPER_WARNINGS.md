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

## 6. `[switch]` params cross NSIS ExecWait are unsafe - use `-Mode` strings

### The bug (E-19, v2.4.11)

`powershell/Apply-TieredAcl.ps1` originally took a `[switch]$NonRecursive` param.
The pre-ship harness (invoking via PowerShell's direct `& $script -NonRecursive`
operator) saw the switch bind and its `if ($NonRecursive)` branch fire - tier-A
root gained the `Users:(WD,AD,DC)` SQLite sibling-creation grant. Harness passed.

The real installer (invoking via NSIS `ExecWait 'powershell.exe -File ...
-NonRecursive'`) did NOT apply that grant on Greg's box after a clean install.
The root ACL lacked the grant entirely; SQLite fell back to rollback-journal
mode using only the file-specific `Users:M` on `workbench.db`. Required a
manual icacls hotfix.

Exact NSIS-side mechanism was never reproduced in isolation, but two
independent holes stood out:

1. `[switch]` param binding depends on the literal token surviving every
   tokenizer between the NSIS string and PowerShell's param parser.
   `powershell.exe -File script.ps1 -NonRecursive` SHOULD bind the switch
   the same way `& script.ps1 -NonRecursive` does, but the harness and
   install disagreed in production. Empirically unsafe.
2. The harness invoked the helper via direct `&` while the installer used
   `-File` subprocess. Even if the param binding matched, other things
   (`$PSScriptRoot`, exit-code capture, transcript behaviour) differ.

### The fix (v2.4.12)

Two layers of defense:

- **String param with `ValidateSet`** - replaced `[switch]$NonRecursive` with
  `[ValidateSet('root','recurse')][string]$Mode = 'recurse'`. A string value
  binds unambiguously across every invocation form; there's no "switch
  present vs absent" state to lose in tokenization.

- **Harness mirrors installer form** - `scripts/test-installer-acl.ps1` now
  invokes `Apply-TieredAcl.ps1` via `powershell.exe -File` subprocess (the
  same form `ExecWait` uses in installer.nsh). What we test is byte-for-byte
  what we ship.

Plus a post-install verification script (`Verify-InstalledAcl.ps1`) run by
the installer against the REAL install state, writing a log to
`C:\ProgramData\PCDoctor\logs\install-verify-*.log`. Harness catches design
bugs; verify catches install-time drift.

### Rules

- **Do not** add a new `[switch]` param to any helper script that's invoked
  via `powershell -File` or NSIS `ExecWait`. Use `ValidateSet` strings.
- **Do not** change the harness's invocation form. It MUST stay
  `powershell.exe -File $applyScript ...` matching the installer.
- If you rename the `-Mode` values or add a new mode, update BOTH the
  harness and the installer in the same commit, and re-run the harness
  before rebuilding.

## 7. Defender races icacls — exclusion + sleep, don't optimise away

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

## 8. Event 41 Kernel-Power is not a BSOD

### The bug (v2.4.34)

`powershell/Invoke-PCDoctor.ps1` had:

```powershell
if ($sysErrors | Where-Object { $_.Id -in 41, 1001 -and $_.ProviderName -match 'Kernel-Power|BugCheck' }) {
    Add-Finding warning 'Stability' 'Unexpected shutdowns or BSODs detected in last 7 days'
}
```

This fired a single combined finding on Event 41 (Kernel-Power, any unclean
boot) OR Event 1001 (BugCheck, actual BSOD). Downstream the alert rule
`alert_bsod_24h` matched `/bsod|kernel panic|bugcheck/i` against the
finding message -- which included the word "BSODs" -- so Event 41 alone
triggered a critical "BSOD in last 24h" Telegram alert. Greg got one
every night for weeks.

### Why it's wrong

Event 41 fires on ANY unclean boot:

- Power loss (PSU cutoff, UPS failure, power-strip switched off)
- Forced reset (reset button)
- User holds the power button through a hang
- Sleep / hibernate failures
- BSOD

Only the last is a BSOD. The rest are environmental or user actions, not
kernel faults. Treating 41 as a BSOD produces nightly false positives on
any machine that experiences occasional power hiccups.

### The rule

**Scanner side:**
- "BSOD" = BugCheck event 1001 OR a file in `C:\Windows\Minidump\*.dmp`
  newer than the scan window. Never Event 41 alone.
- "Unexpected shutdown" = Event 41 Kernel-Power with no matching 1001
  and no minidump. Info severity. Logged for visibility, never an alert.

**Alert side:**
- Match ONLY the tight finding with an area guard:
  `f.area === 'Stability' && /^BSOD detected/i.test(f.message)`.
- Do NOT use loose keyword regex that happens to catch the soft finding.
- Scan window must match the alert title. If the scanner looks back 7
  days, the alert must say "7 days", not "24h".

### Rules

- When a finding describes multiple conditions of different severity, split
  them. One finding = one signal.
- Alert matchers must be anchored (`^...`) and area-guarded. Loose substring
  regex on free-form finding text WILL eventually match unrelated content.
- The `OBSOLETE_RULE_IDS` list in `src/main/autopilotEngine.ts` deletes
  renamed rule rows on seed. If you rename a rule id, add the old id to
  that list AND keep it there forever -- dropping an id lets it resurrect
  on machines still carrying the old row.

### Regression coverage

`tests/main/autopilotEngine.test.ts` has a `describe('alert_bsod_7d matcher')`
block that locks in positive + three negative cases. If you ever see that
block go red, **the regex has been loosened** -- re-tighten it.

## References

- [`scripts/installer.nsh`](../scripts/installer.nsh) — the NSIS install hook
- [`scripts/test-installer-acl.ps1`](../scripts/test-installer-acl.ps1) — pre-ship gate
- [`powershell/Apply-TieredAcl.ps1`](../powershell/Apply-TieredAcl.ps1) — shared ACL logic
- [`powershell/Heal-InstallAcls.ps1`](../powershell/Heal-InstallAcls.ps1) — runtime self-heal
- [`powershell/Verify-InstalledAcl.ps1`](../powershell/Verify-InstalledAcl.ps1) — post-install verification (v2.4.12)
- [`powershell/Repair-ScriptAcls.ps1`](../powershell/Repair-ScriptAcls.ps1) — zero-ACE safety net
- [`src/main/scriptRunner.ts`](../src/main/scriptRunner.ts) — elevated arg-emission logic
- [`src/main/main.ts`](../src/main/main.ts) — startup self-heal hook (line ~231)
