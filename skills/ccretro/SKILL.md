---
name: ccretro
description: Run a ccretro retrospective of the user's Claude Code usage, open the report, then turn its "what to do next" suggestions into real changes — new or updated skills, CLAUDE.md lines, hooks, permission rules — after the user picks which ones. Use for "振り返り", "retro", "ccretro", "look back at how I used Claude Code", or a monthly review.
argument-hint: "[--days N] [--exclude-project name ...] [--redact]"
---

# ccretro: look back, then act on it

The report alone changes nothing. This skill closes the loop: generate the retrospective, then apply the suggestions the user agrees with, preferring to update what already exists over adding more.

## 1. Generate

Run the copy of ccretro that ships with this plugin, passing the user's arguments through (default period: 30 days). It prints the HTML path on stdout; the JSON with the same basename sits next to it.

```bash
node "${CLAUDE_SKILL_DIR}/../../bin/ccretro.mjs" $ARGUMENTS
```

- If the user gave a bare number ("/ccretro 7"), turn it into `--days 7`; the CLI takes no positional arguments.
- If that path doesn't exist (the skill was copied without the rest of the repo), fall back to `npx --yes github:0-draft/ccretro`.
- It calls `claude -p` for the narrative. If that fails (no network in a sandbox, not logged in), it falls back to rule-based output and says so on stderr. Tell the user which one they got.
- If the user has private projects they don't want summarised, pass `--exclude-project <name>` or point them at `~/.config/ccretro/config.json` (`{"excludeProjects": [...]}`).

## 2. Read the result

Read the `.json` file, not the HTML. Use:

- `insight.nextActions`: the suggestions (`kind`, `title`, `why`, `how`, optional `snippet`)
- `repeated`: prompts typed again and again, with counts
- `inventory`: skills, subagents, hooks, and per-project CLAUDE.md the user already has
- `insight.fluency` / `insight.patterns`: context for why a suggestion matters

Give the user a short summary in their language: the headline, and the suggestions as a numbered list with the evidence count behind each.

## 3. Check each suggestion against the real config

Before proposing a change, look at what exists. The JSON inventory is a hint; the files are the truth.

- Skills: list `~/.claude/skills/*` and the project's `.claude/skills/*`. Resolve symlinks — if a skill dir links into a dotfiles repo, edit the file in that repo.
- Read any skill whose name or description overlaps the suggestion. **If one already covers most of it, propose an edit to that skill instead of a new one.**
- CLAUDE.md: read `~/.claude/CLAUDE.md` (follow its symlink) and the project's. Don't add a line that restates an existing rule; tighten the existing rule instead.
- Hooks / permissions: read `~/.claude/settings.json`. Settings changes go through the `update-config` skill if available.

Drop suggestions that turn out to be already done, and say why.

## 4. Let the user choose

Ask once, with a multi-select listing the surviving suggestions, each labelled new vs update and the target path. Do not apply anything they didn't pick.

## 5. Apply

For each picked item:

- **New skill**: `<skills-dir>/<name>/SKILL.md` with `name` and a `description` that says when to trigger it. Write the steps from what the user actually typed (quote the repeated prompt's intent), not generic advice. Keep it short.
- **Skill update**: minimal edit to the existing SKILL.md; keep its structure and voice.
- **CLAUDE.md**: one or two lines in the matching section.
- **Hook / permission**: via `update-config`.
- If the config lives in a git repo, show `git diff` for the touched files. Do not commit or push unless the user asks; follow that repo's commit conventions if they do.
- If the skills dir is populated by an install script (symlinks into a repo), tell the user to re-run it for new skills to appear.

## 6. Report

List what changed (paths), what was skipped and why, and the HTML report path. Suggest re-running monthly; `/schedule` can automate the report part, but applying changes always waits for the user.
