# PCDoctor Workbench v2.1.0 — Code Review

**Reviewer:** code-reviewer sub-agent
**Date:** 2026-04-18
**Scope:** 100 commits from `fc7391e` (p3 Dashboard) to `d891c53` (v21e4 packaging fix).
**Files inspected:** 45 TS/TSX + 24 PS1 + preload + shared.

---

## Summary

| Severity  | Count |
|-----------|-------|
| Critical  | 2     |
| Warning   | 9     |
| Suggestion| 7     |

The app has **no SQL injection, no XSS sinks, no OS-shell command injection**, and PowerShell arguments are passed as separate spawn args (not through a shell), which eliminates the largest attack class. The critical findings below are about **secret handling on the IPC boundary** and a **deserialisation-controlled file-write in the rollback path**. Everything else is polishable warnings and style violations (em dashes everywhere).

---

## Critical (must fix)

### C1. Telegram bot token is round-tripped in cleartext to the renderer on every Settings load
`src/main/ipc.ts:370-387`, `src/renderer/pages/Settings.tsx:60`

`api:getSettings` deliberately decrypts the DPAPI-wrapped `telegram_bot_token` and returns the plaintext value in the `data` object every time the Settings page mounts (and anywhere else `getSettings` is invoked). That defeats most of the benefit of the DPAPI work in commit `8342887` — any renderer-side XSS, a mis-scoped `contextBridge` addition, a console.log left in a handler, or a future exfil bug now leaks the token.

Also, `src/shared/types.ts:349` still carries the stale comment `"Stored unencrypted in SQLite for this release; DPAPI encryption is a hardening follow-up."` which is false as of `8342887`.

**Suggested fix (one-liner):** in `ipc.ts` handler, return `'••••'` (or the last 4 chars) for `telegram_bot_token` unless the caller explicitly asked for the raw value, e.g. add a `api:revealTelegramToken` handler gated on an in-app confirm modal. At minimum:
```ts
if (v?.startsWith('dpapi:')) all[k] = '••••configured••••';
```
Then change Settings.tsx:60 to leave `tgToken` empty when the placeholder is returned, and only write it back if the user retypes a real token.

### C2. Snapshot revert blindly `cpSync`s manifest-declared source paths
`src/main/rollbackManager.ts:144-155`

`revertRollback` reads `manifest.json` from the snapshot directory and calls `cpSync(p.snapshot, p.source, { recursive: true, force: true })` for every entry. The manifest is written by `prepareRollback` to a path under `C:\ProgramData\PCDoctor\snapshots\<id>\`, which is writable by any local user (ProgramData ACLs) unless explicitly hardened.

If a non-admin attacker (or any process running as the user) can tamper with `manifest.json` between rollback creation and revert, they can redirect `p.source` to anywhere — e.g. `C:\Windows\System32\drivers\...` — and have the (elevated) app overwrite it on the next revert. The revert path is user-triggered from the UI and is a normal code path, so this is exploitable without any elevation gap.

**Suggested fix (one-liner):** validate every `p.source` against `action.snapshot_paths` for the original action, or at minimum reject any `p.source` that isn't also under `PCDOCTOR_ROOT` / `%APPDATA%` / `%LOCALAPPDATA%` of the current user. Also: write the manifest out-of-tree (e.g. into the SQLite row instead of a JSON file), or HMAC it with a DPAPI-sealed key.

---

## Warnings (should fix)

### W1. 30 source files contain em dash (`—`) characters
**Rule violated:** "No em dashes anywhere (code, comments, UI text, error messages)".
Grep across `src/` found `—` in **24 TS/TSX files** + the 6 PS1 scripts. Pervasive in comments, UI fallback text (`'—'`), and string literals.

Examples:
- `src/main/ptyBridge.ts:12` — comment
- `src/main/ipc.ts` — 35 occurrences (mostly `// —` comment dividers)
- `src/renderer/components/dashboard/AuthEventsWidget.tsx:46` — rendered UI fallback
- `src/renderer/components/dashboard/BsodPanel.tsx:39,40,41,42` — rendered UI
- `src/main/pcdoctorBridge.ts:9,73,75,307` — includes user-visible error message at line 307 (`makeOverallLabel` returns `"${state} — ${parts.join(', ')}"` which is shown on the Dashboard)

**Suggested fix:** batch sed the char to ` - ` (ASCII hyphen with spaces) for comments/strings. Audit the UI fallbacks (`'—'`) in AuthEventsWidget/BsodPanel/etc and replace with a plain `-`. The `makeOverallLabel` join separator is the most user-visible instance.

### W2. Telegram `from.id` check uses string comparison against user-supplied chatId
`src/main/telegramBridge.ts:129`
```ts
if (upd.callback_query && upd.callback_query.from.id.toString() === chatId && handlerFn)
```
`chatId` comes from `getSetting('telegram_chat_id')` (user-entered). If the user accidentally saves `"  12345  "` with stray whitespace, the comparison silently fails and every legitimate callback is ignored. Not a security hole, but a silent-dead-loop bug.

**Suggested fix:** `chatId.trim()` when reading, or `setSetting` validates numeric-only.

### W3. Claude bridge `commands.jsonl` watcher is vulnerable to rapid-fire bypass of the window check
`src/main/claudeBridgeWatcher.ts:56-60`

If `win` is null at the moment the command is processed, the command is rejected. But:
- `fs.watch` can fire multiple times for a single write; processing is not serialized.
- If the user *closes* the main window between the watcher reading the line and opening the approval prompt, the ipcMain.once handler never fires and the 90s timeout resolves false — OK.
- BUT if two commands are written in the same tick, they're handled sequentially inside the `for` loop awaiting each `handleClaudeCommand`. During that 90s wait, new writes update `lastProcessedLine` but each handler still holds its own approval listener — fine.

However the watcher **never validates the JSON schema**: any field in `ClaudeCommand` can be an arbitrary string from an attacker who has write access to `commands.jsonl`. The `action` string is later looked up in `ACTIONS` dictionary (`actionRunner.ts:16`), which gracefully rejects unknown names — good. `params` is passed straight through to `runPowerShellScript` — which, as analyzed, is safe because args are not shell-interpreted. Still, a schema validator (zod) would be the right hardening step.

**Suggested fix:** Validate `cmd.action` against `ACTION_NAMES` before calling `runAction`, and bound `cmd.params` size (e.g. reject objects >1KB).

### W4. `startClaudeBridgeWatcher` uses `fs.watch` recursively with no error listener
`src/main/claudeBridgeWatcher.ts:36`
`fs.watch(BRIDGE_DIR, ...)` has no `on('error', ...)` handler. If the OS drops the watch (antivirus, permission change, USB eject of ProgramData volume), the bridge silently dies with no feedback. Users would assume Claude approvals still work.

**Suggested fix:** attach `.on('error', (e) => console.error('claude-bridge watcher error', e))` and retry the watch.

### W5. `getSettings` exports *all* settings including keys the renderer doesn't need
`src/main/ipc.ts:370-387`
Only `telegram_bot_token` is singled out for decryption, but if future sensitive settings are added (OAuth tokens, API keys) they'll leak by default. The settings allow-list should be explicit.

**Suggested fix:** introduce a `RENDERER_SAFE_KEYS` set and filter `all` through it before returning.

### W6. `emailDigest.ts:85,89` interpolate `latestReview.hostname` and `latestReview.summary.overall` directly into HTML without escaping
`src/main/emailDigest.ts:85, 89`
Line 85: `<p>${latestReview?.hostname ?? 'Unknown host'} ...</p>`
Line 89: `<p><strong>${latestReview.summary.overall}</strong> — ...</p>`
These come from weekly-review JSON, not user input, but the JSON is written by PS scripts that do include user-reachable data (logged-on usernames, hostnames set by the user). Low-risk HTML injection with user-controlled source.

**Suggested fix:** wrap both in `escapeHtml(...)` (already defined in the same file at line 111).

### W7. `actionRunner.ts:60` capitalizes param keys without validating them
`src/main/actionRunner.ts:58-62`
```ts
for (const [k, v] of Object.entries(input.params)) {
  scriptArgs.push(`-${k.charAt(0).toUpperCase() + k.slice(1)}`, String(v));
}
```
`k` is trusted (it comes from `ACTIONS[name].params_schema`), but the value `v` is not validated. A param value of `"-Force"` or any string starting with `-` is pushed as its own argv token. Because `spawn` passes argv straight to `pwsh -File`, PowerShell's `param()` binder could misparse it as another switch. Example: `runAction({name:'kill_process', params:{target:'-Force'}})` — the target value `-Force` would get bound to `$Target` only if PS's `[string]` positional binding wins over switch-name matching; with the named `-Target` pass before the value, this is actually fine in practice.

BUT there is no current validation that `v` matches the `type`/`pattern` from `params_schema`. A scheduler, alert handler, or bridge caller could pass a value that the PS script then uses in a sensitive context.

**Suggested fix:** validate each `v` against `def.params_schema[k].pattern` (regex) or `type` before running. Reject with `E_INVALID_PARAM`.

### W8. `pcdoctorBridge.ts:307` uses em dash inside a user-visible string
`return parts.length ? \`${state} — ${parts.join(', ')}\` : state;`
This text is the big "OK — 2 critical, 1 warning" banner on the dashboard. Most visible em-dash violation.

**Suggested fix:** `${state} - ${parts.join(', ')}`.

### W9. `autoUpdater` has no code-signing verification gate
`src/main/autoUpdater.ts`
The auto-updater points at a NAS publish target (per commit `8cc7ada`). electron-updater verifies the signature of the installer when `signtool` was used, but the downgrade guard (`autoUpdater.allowDowngrade = false`) and no pinned public key means anyone with write access to the NAS share can publish a malicious "higher version" and it will be auto-downloaded. Given this ships to a home lab, the blast radius is limited, but still worth a note.

**Suggested fix:** pin a public key via `electron-updater`'s `publisherName` or sign the `latest.yml` with a known key.

---

## Suggestions (consider)

### S1. `as any` and `: any` usage = 91 occurrences across 24 files
Many are genuinely necessary (IPC boundary, untyped third-party imports), but several could be typed properly:
- `src/main/ipc.ts:35` — 35 occurrences, highest concentration. Most are `e: any` in `catch` blocks (typical). A few `any` returns like line 279 `Promise<IpcResult<any[]>>` for `listBlockedIPs` could be typed.
- `src/renderer/components/dashboard/BsodPanel.tsx:6` — `const [result, setResult] = useState<any>(null)`. Should be a `BsodAnalysis` interface.
- `src/renderer/components/layout/ClaudeApprovalListener.tsx:8` — `params?: any;` should mirror the `ClaudeCommand` interface in main.

### S2. `catch {}` swallows 33 errors silently
Most are OK (best-effort side effects), but a few warrant at least a `console.warn`:
- `actionRunner.ts:51` — `prepareRollback` failure is silently ignored. The user clicks "Restart Service with rollback" and the rollback might not exist.
- `ipc.ts:267` — auto-block RDP brute-force failure is silent; user cannot know why the block didn't happen.
- `claudeBridgeWatcher.ts:48-52` — malformed JSONL line is dropped with no log. Makes Claude bridge debugging painful.

**Suggested fix:** log these at `console.warn` level with short context.

### S3. `ClaudeTerminal.tsx:75` useEffect depends on `contextText` prop
If a parent re-renders with a new `contextText` string (e.g. new `Date().toISOString()` in a template literal), the PTY is torn down and respawned. Should be `useRef`d or depended only on `sessionId`.

### S4. `ptyBridge.ts:86` builds a cmd.exe command string with quoted paths
```ts
ptyModule.spawn(shell, ['/k', `"${claudePath}" --add-dir "${PCDOCTOR_ROOT}"`], ...)
```
`claudePath` / `PCDOCTOR_ROOT` are trusted, but if either ever contains a `"` the command breaks. Use `cmd /k` with separate args or bypass cmd.exe and spawn `claudePath` directly.

### S5. `telegramBridge.ts:108` uses `setInterval(30_000)` forever
No upper-bound backoff when Telegram is down. If the bot token is wrong for 30 days, you'll have 86,400 failed requests logged in `notification_log`. Add exponential backoff on consecutive failures.

### S6. Dead code candidates
- `claudeBridge.ts:64-121` defines both `launchClaudeInTerminal` and `launchClaudeWithContext` — these have ~60% overlap (nearly identical body). Extract the shared `spawnClaudeInWt(ctxPath)` helper.
- `rollbackManager.ts:98-111` has `updateRollbackSnapshotPath` helper with an eslint-disable and a TODO about moving it to dataStore. Do that.

### S7. `notifier.ts:106` passes raw `opts.title`/`opts.body` through HTML `escape()` but the `escape` function doesn't escape `"` or `'`
`notifier.ts:121-123`. If a finding message contains `<img src=x onerror=…>` it's handled (via `<`). But if Telegram ever renders attributes (it does for `<a href="...">`) this wouldn't protect against attribute-context injection. Currently Telegram HTML mode only supports a narrow tag whitelist without attributes for our usage, so this is theoretical.

---

## Things that are **not** findings (reviewed, cleared)

- **SQL injection:** All `db.prepare(...)` calls use `?` placeholders. The one template-literal branch in `dataStore.ts:440,444` is a Boolean selector for adding `AND label = ?`, not user-controlled. ✓
- **OS shell command injection:** `runPowerShellScript` uses `spawn(pwsh, args, opts)` with no `shell: true`. All PS actions reviewed (Kill-Process, Restart-Service, Block-IP, Unblock-IP, Import-HWiNFO-CSV, Import-OCCT-CSV, Hide-KB, Install-KB, Disable-Startup-Item). PS param binding treats values as data. ✓
- **Path traversal into sensitive locations via CSV imports:** `Import-HWiNFO-CSV.ps1` / `Import-OCCT-CSV.ps1` call `Test-Path`, `Get-Content`, `[System.IO.File]::OpenRead` on the user-supplied path. This is a *read* operation, so the worst case is reading a file the logged-in user already has access to. Not a privilege-escalation path. ✓
- **Approval modal race conditions in Claude bridge:** the `ipcMain.once` + 90s timeout + `resolve(false)` fallback is correctly implemented; the approval gate genuinely blocks. ✓
- **Telegram `from.id` check:** `telegramBridge.ts:129` correctly filters callbacks to the configured chatId. Two-step destructive-action flow in `main.ts:121-137` correctly routes through the confirmation modal. ✓
- **Preload/contextBridge:** `src/preload/preload.ts` uses `contextBridge.exposeInMainWorld` with contextIsolation+sandbox+nodeIntegration=false in `main.ts:33-38`. No Node globals exposed. ✓
- **No `dangerouslySetInnerHTML`, `eval`, `new Function` in renderer.** ✓
- **No hardcoded secrets in checked-in code.** (Token lives in SQLite at runtime.) ✓

---

## Top 3 to hand to a fixer next

1. **C1** — stop round-tripping the Telegram bot token to the renderer. Change `api:getSettings` to mask, add `api:revealTelegramToken` behind a confirm. 5-line change + 2-line Settings.tsx adjustment.
2. **W1** — em dash sweep. Probably a 15-minute job with a global find-replace, but needs a careful audit of the ~20 user-visible instances (especially `pcdoctorBridge.ts:307` and the BsodPanel/AuthEventsWidget fallbacks).
3. **C2** — validate `p.source` paths in `revertRollback` before `cpSync`. Either allow-list against the original action's `snapshot_paths`, or constrain to user-home / ProgramData prefixes.
