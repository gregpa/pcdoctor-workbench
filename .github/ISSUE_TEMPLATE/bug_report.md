---
name: Bug report
about: Something broke or behaved unexpectedly
title: '[BUG] '
labels: bug
---

## What happened

<!-- Describe the bug in 1-2 sentences. What did you do, what did you expect, what actually happened? -->


## Steps to reproduce

1.
2.
3.

## Environment

- **PCDoctor Workbench version:** <!-- Settings → About, OR run: (Get-Item "C:\Users\$env:USERNAME\AppData\Local\Programs\PCDoctor Workbench\PCDoctor Workbench.exe").VersionInfo.FileVersion -->
- **Windows version:** <!-- Run: winver -->
- **Hardware:** <!-- e.g. Dell XPS 15, Alienware desktop -->

## Perf log lines (if relevant)

<!--
The renderer + main process log to:
  C:\ProgramData\PCDoctor\logs\perf-YYYYMMDD.log
  C:\ProgramData\PCDoctor\logs\render-perf-YYYYMMDD.log

If your bug is about a UI hang, slow refresh, or unexpected error, paste the
last ~30 lines from BOTH files around the time the bug occurred.

PRIVACY: perf logs may contain your hostname, drive letters, and Windows
service names. They do NOT contain Telegram tokens, file content, or
secrets. If hostname leaking concerns you, redact before pasting — this
issue tracker is public.

Quick PowerShell to grab the last 30 lines of each:

  $today = Get-Date -Format 'yyyyMMdd'
  Get-Content "C:\ProgramData\PCDoctor\logs\perf-$today.log" -Tail 30
  Get-Content "C:\ProgramData\PCDoctor\logs\render-perf-$today.log" -Tail 30
-->

```
(paste perf log lines here, redact hostname if desired)
```

## Screenshots

<!-- If the bug is visual, drag-and-drop a screenshot here. -->

## Additional context

<!-- Anything else: known triggers, when it started happening, antivirus running, etc. -->
