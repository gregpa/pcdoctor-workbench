# CLAUDE.md — <PROJECT NAME>

> Portable starter. Copy to a new repo's root as `CLAUDE.md`, then fill the
> `<...>` placeholders and delete what doesn't apply. Keep it under ~80 lines —
> a memory file, not a manual. Link out to long-form docs instead of inlining.

Guidance for Claude Code (and humans) working in this repo.

## What this is

<One paragraph: what the app/library does, who the primary user is, and any
critical constraints — target OS, "personal tool", "production service", etc.>

## Architecture map

| Path | Role |
|------|------|
| `<dir>/` | <what lives here> |
| `<dir>/` | <what lives here> |

## Commands

```
<cmd>   # dev server / run
<cmd>   # typecheck — must be clean
<cmd>   # tests
<cmd>   # lint
<cmd>   # build / package
```

## The "Gates" ritual — run before every commit

The fixed verification sequence for this project. The `/gates` slash command
(`.claude/commands/gates.md`) runs it.

1. `<typecheck cmd>` → must be clean
2. `<test cmd>`      → record pass count
3. `<lint cmd>`      → errors must be 0
4. `<any project-specific gate>`

> Note any environment caveats (native builds, platform-only tests, services
> that must be running) so a fresh clone / CI doesn't misread failures.

## Landmines — read before touching these

- **<fragile area>**: <what breaks and where to read first>.
- **<fragile area>**: <invariant that must not be "simplified" away>.

## Conventions

- **Commit messages**: <format — e.g. Symptom / Fix / Gates / Out-of-scope>.
- **Dependencies**: <policy>.
- **Where plans/reviews live**: <path>.
