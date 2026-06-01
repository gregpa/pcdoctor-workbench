# Claude Code Workflow — Per-Project & Global Setup

How the Claude Code "memory" and command layers fit together, what to put
where, and how to keep your **global** setup identical across machines.

This doc is reusable across all your projects; it isn't specific to PCDoctor.

---

## 1. The three scopes

Claude Code reads instruction/command files from three places, most-global to
most-specific. More-specific layers add to (and can override) broader ones.

| Scope | Location | Checked in? | Use it for |
|-------|----------|-------------|------------|
| **Global / personal** | `~/.claude/CLAUDE.md`, `~/.claude/commands/`, `~/.claude/settings.json` | No (your machine) | Defaults that apply to **every** project: how you like commits written, "always typecheck before claiming done", personal slash commands. |
| **Project** | `<repo>/CLAUDE.md`, `<repo>/.claude/commands/`, `<repo>/.claude/settings.json` | **Yes** (shared with the team/repo) | Project facts: architecture, build/test commands, landmines, the project's `/gates`. |
| **Project-local** | `<repo>/CLAUDE.local.md`, `<repo>/.claude/settings.local.json` | No (gitignored) | Your private per-repo notes & machine-specific paths. |

Rule of thumb: **project-specific knowledge → committed in the repo; personal
habits → global on your machine.** Don't put PCDoctor's `icacls` landmine in the
global file, and don't put "I like Symptom/Fix/Gates commits" in every repo.

---

## 2. Recommended GLOBAL `~/.claude/CLAUDE.md`

This is the part that "fixes the workflow for any project you start." Create
`~/.claude/CLAUDE.md` on your machine with your personal defaults. A starting
point that matches how you already work:

```markdown
# Personal defaults (Greg)

## Verification discipline
- Never claim a task is done until typecheck/build and tests actually pass.
  Run them; don't assume. Report real counts, not "should work".
- If a project has a `/gates` command or a CLAUDE.md "Gates" section, run it
  before committing and paste the result counts into the commit body.
- Distinguish environment-artifact failures (missing native build, wrong OS)
  from real regressions, and say which.

## Commits
- Format: a one-line summary, then a body with
  Symptom / Fix / Gates / Out-of-scope.
- Always record the gate counts (e.g. `vitest 897/897`) in the body.
- Don't commit or push unless I ask.

## Working style
- Prefer plan mode for anything touching >1 file or that's hard to reverse.
- Keep CLAUDE.md / docs lean; link rather than duplicate.
- Ask before adding dependencies or running destructive/outward-facing actions.
```

Keep it short. This loads into **every** session on that machine.

## 3. Global slash commands `~/.claude/commands/`

Drop reusable commands here and they're available in every repo as `/<name>`.
Good candidates that aren't project-specific:

- `~/.claude/commands/ship.md` — your "prep a release" checklist.
- `~/.claude/commands/review.md` — your preferred self-review pass.

Project-specific commands (like PCDoctor's `/gates`, which runs PowerShell
smoke tests) stay in the **repo's** `.claude/commands/` instead — they're
meaningless elsewhere.

---

## 4. Keeping it identical across machines (second system)

Your `~/.claude/` directory isn't tied to one computer — treat it like dotfiles.
Pick one approach:

### Option A — version it as a git repo (recommended)

On your **primary** machine:

```bash
cd ~/.claude
git init
# Only track the portable bits; never your auth/session data.
printf '%s\n' \
  '*' \
  '!CLAUDE.md' \
  '!commands/' \
  '!commands/**' \
  '!settings.json' \
  '!.gitignore' > .gitignore
git add CLAUDE.md commands settings.json .gitignore
git commit -m "Personal Claude Code config"
# push to a PRIVATE repo
git remote add origin git@github.com:gregpa/claude-config.git
git push -u origin main
```

On the **second** machine:

```bash
# back up anything already there, then:
git clone git@github.com:gregpa/claude-config.git ~/.claude-config
ln -s ~/.claude-config/CLAUDE.md     ~/.claude/CLAUDE.md
ln -s ~/.claude-config/commands      ~/.claude/commands
ln -s ~/.claude-config/settings.json ~/.claude/settings.json
```

Now `git pull` in `~/.claude-config` on any machine syncs your global workflow.

### Option B — fold it into an existing dotfiles repo

If you already manage dotfiles (chezmoi, GNU stow, bare-repo, etc.), add
`~/.claude/CLAUDE.md`, `~/.claude/commands/`, and `~/.claude/settings.json` to
it the same way you manage `.gitconfig`.

### What NOT to sync

Never commit credentials or session state from `~/.claude/`:
`.credentials.json`, `auth`, OAuth tokens, `projects/`, `todos/`, `history`,
caches. The `.gitignore` in Option A is allow-list style (`*` then `!`) for
exactly this reason — only the three portable files are tracked.

---

## 5. Per-project quickstart (new repo)

1. Copy `docs/templates/CLAUDE.template.md` → `<repo>/CLAUDE.md`, fill it in.
2. Copy `docs/templates/gates.template.md` → `<repo>/.claude/commands/gates.md`.
3. Commit both so the team/repo and future sessions share them.
4. Your **global** `~/.claude/CLAUDE.md` is already active on top of them.
```
