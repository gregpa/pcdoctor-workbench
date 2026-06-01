---
description: Run the PCDoctor pre-commit verification gates and report counts
---

Run this project's "Gates" verification ritual and report the result of each
step the way it appears in commit messages (e.g. `vitest 897/897`).

Steps, in order — do not skip, and report each one's count/status:

1. `npm run typecheck` — must be clean (no errors).
2. `npm test` — report `vitest <passed>/<total>`.
3. `npm run lint` — report error/warning counts (errors must be 0).
4. `npm run test:ps51` — PS 5.1 syntax. **Windows + pwsh only.**
5. `scripts/test-worker-smoke.ps1` — worker smoke (pwsh 7 + PS 5.1).
   **Windows + pwsh only.**

Notes:
- Steps 4–5 only run on Windows. If you're on Linux/macOS, mark them
  `skipped (not Windows)` rather than failing.
- If vitest shows ~70 failures referencing `better_sqlite3.node` or Win32
  paths, you're on a non-Windows host without a native build — call that out as
  an environment artifact, not a regression, and note the suite must be run on
  Windows to be authoritative.
- Finish with a one-line summary block ready to paste into a commit's `Gates:`
  line.
