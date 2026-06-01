---
description: Run this project's pre-commit verification gates and report results
---

> Portable starter. Copy to a new repo as `.claude/commands/gates.md`, then
> replace the `<...>` steps with the project's real commands. Invoke with
> `/gates`.

Run this project's verification gates in order. Do not skip steps. Report each
step's status/count, then end with a one-line summary ready to paste into a
commit message.

1. `<typecheck cmd>` — must be clean.
2. `<test cmd>` — report `<passed>/<total>`.
3. `<lint cmd>` — errors must be 0; report warning count.
4. `<project-specific gate, if any>`.

Notes:
- Mark platform-only or service-dependent steps `skipped (<reason>)` instead of
  failing when their prerequisites aren't present.
- Flag known environment-artifact failures (missing native builds, etc.) as
  such rather than reporting them as regressions.
