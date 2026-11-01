# ccretro

A monthly-review style retrospective of your Claude Code usage, rendered as a local web page.

ccretro reads the transcripts Claude Code already keeps in `~/.claude/projects`, aggregates them on your machine, asks your own `claude` CLI to write the narrative, and opens a self-contained HTML report.

## What it shows

- **Headline and summary**: what the period was about, in a sentence or two
- **Rhythm**: most active weekday, peak hour, sessions, prompts, active days, wall-clock hours (parallel sessions merged)
- **Activity chart**: prompts or active hours per day, plus a weekday × hour heatmap
- **What you worked on**: themes and their share of prompts
- **AI fluency (4D)**: delegation, description, discernment, diligence, each with evidence from your data and a copyable prompt
- **What to do next**: concrete suggestions with ready-to-paste snippets (skills, hooks, CLAUDE.md, permissions, subagents), skipping anything you already have set up
- **Prompts you keep typing**: repeated instructions, the usual source of skill and hook ideas
- **Friction**: interrupts, rejected tool uses, tool error rate, compactions
- **How you used it**: tools, skills, subagents, MCP servers, slash commands, file types edited, models

The period switch (7 days / 1 month / 3 months / all time) recomputes every number in the page. The written narrative is generated for the period passed with `--days`.

## Usage

Requires Node.js 20+ and the `claude` CLI (logged in) for the narrative.

```bash
npx github:0-draft/ccretro          # last 30 days, opens the browser
npx github:0-draft/ccretro -d 7     # last week
npx github:0-draft/ccretro --no-ai  # numbers and rule-based suggestions only, no claude call
npx github:0-draft/ccretro --dry-run  # print exactly what would be sent to claude
```

Or from a clone:

```bash
node bin/ccretro.mjs --help
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-d, --days <n>` | `30` | period the narrative covers (`0` = all time) |
| `-l, --lang <ja\|en>` | auto | auto picks from locale, then from the language of your prompts |
| `-m, --model <id>` | your default | model for `claude -p` |
| `--no-ai` | off | skip the `claude -p` call |
| `--dry-run` | off | print the digest and exit |
| `-o, --out <file>` | `~/.cache/ccretro/report-<date>.html` | output path |
| `--no-open` | off | don't open the browser |

## Privacy

- Parsing and aggregation run locally. Per-file summaries are cached in `~/.cache/ccretro/index.json` so later runs take a second or two.
- The narrative step sends a digest (counts, project names, session titles, and about 140 sampled prompts truncated to 220 characters) to Claude through your own `claude -p`, the same path as any Claude Code session. Use `--dry-run` to read it first, or `--no-ai` to skip it.
- The `claude -p` call runs with no tools, no MCP servers, and `--no-session-persistence`, so it doesn't show up in your own history.
- The HTML report does not embed raw prompts, except the short "prompts you keep typing" list. Check that section before sharing a screenshot.

## How the numbers are counted

- **Prompts**: messages you typed, including slash commands. Tool results, injected reminders, interrupts, and headless (`claude -p` / SDK) sessions are excluded; prompts copied into resumed sessions are de-duplicated by UUID.
- **Active hours**: spans of transcript activity with gaps under 5 minutes, merged across all sessions, so running three sessions in parallel for an hour counts as one hour.
- **Tool error rate**: tool results flagged `is_error` divided by all tool calls.

Transcripts older than Claude Code's `cleanupPeriodDays` (30 days by default) are already deleted, so "all time" means "what is still on disk".

## License

MIT
