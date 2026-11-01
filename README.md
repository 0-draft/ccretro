# ccretro

A monthly-review style retrospective of your Claude Code usage, rendered as a local web page, plus a `/ccretro` skill that turns its suggestions into actual skills, CLAUDE.md lines and hooks.

```bash
npx github:0-draft/ccretro
```

## Why not just `/insights`?

Claude Code ships `/insights` and `/usage`, and they are good. Use them. ccretro covers what they don't:

| | `/insights`, `/usage` | ccretro |
| --- | --- | --- |
| Window | recent unanalysed sessions; history deleted after `cleanupPeriodDays` (30 by default) | any period, and summaries are archived so a quarter or a year still works after Claude Code deletes the transcripts |
| Change over time | no | every KPI against the previous period of the same length |
| Follow-through | suggestions are one-off | the next retro checks whether last time's suggestions happened (skill now exists, repeated prompt dropped) |
| Framing | friction, quick wins | 4D AI Fluency (delegation, description, discernment, diligence) with evidence from your own prompts |
| Repeated prompts | no | the instructions you keep typing, ranked; the usual source of skill and hook ideas |
| Sharing | no | `--redact` produces a page you can screenshot without leaking project, skill or session names |
| Applying | `/usage` can apply some recommendations | `/ccretro` skill checks your existing skills and CLAUDE.md first and prefers updating them over adding new ones |

## What the page shows

- Headline and a short summary of the period
- Most active weekday, peak hour, sessions, prompts, active days, wall-clock hours (parallel sessions merged), projects, each with change vs the previous period
- API-equivalent cost by day and by model (what the tokens would cost at API list prices; a subscription doesn't bill this)
- Daily prompts, active hours or cost, and a weekday × hour heatmap
- What you worked on, by theme and by project
- AI fluency in four cards, each with evidence and a copyable prompt
- What happened to last time's suggestions
- What to do next, with ready-to-paste snippets
- Prompts you keep typing
- Friction: interrupts, rejected tool uses, tool error rate, compactions, prompt cache hit rate
- Tools, skills, subagents, MCP servers, slash commands, file types, models

The period switch (7 days / 1 month / 3 months / all time) recomputes every number on the page. The written parts cover the period passed with `--days`.

## Usage

Requires Node.js 20+. The narrative uses your logged-in `claude` CLI; without it you get the numbers and rule-based suggestions.

```bash
npx github:0-draft/ccretro              # last 30 days, opens the browser
npx github:0-draft/ccretro -d 7         # last week
npx github:0-draft/ccretro -d 0         # everything on disk and in the archive
npx github:0-draft/ccretro --redact     # share mode
npx github:0-draft/ccretro -x work/acme # leave a project out completely
npx github:0-draft/ccretro --dry-run    # print exactly what would be sent to claude
```

| Option | Default | Meaning |
| --- | --- | --- |
| `-d, --days <n>` | `30` | period the narrative covers (`0` = all time) |
| `-x, --exclude-project <name>` | none | drop a project from stats, HTML and the `claude -p` call; repeatable; matches the path under `$HOME` or the directory name |
| `--redact` | off | share mode: projects, skills, agents and commands become aliases; session titles, repeated prompts and previous suggestions are dropped before anything is built; the narrative uses a separate prompt that forbids names and quotes |
| `-l, --lang <ja\|en>` | auto | from locale, then from the language you write prompts in |
| `-m, --model <id>` | your default | model for `claude -p` |
| `--no-ai` | off | skip the `claude -p` call |
| `--dry-run` | off | print the digest and exit |
| `-o, --out <file>` | `~/.cache/ccretro/report-<date>.html` | output path; a `.json` with the same name sits next to it |
| `--no-open` | off | don't open the browser |

Projects to always exclude, and price overrides, can go in `~/.config/ccretro/config.json`:

```json
{
  "excludeProjects": ["private-notes", "work/acme"],
  "pricing": { "claude-opus-5-5": { "in": 4, "out": 20, "read": 0.2 } }
}
```

Built-in prices are Anthropic's API list prices as of 2026-10-06 (USD per million tokens; cache writes at 1.25x input for the 5-minute TTL and 2x for 1 hour, fast mode at 2x, Claude Haiku 5.5's >100K-prompt tier). Models without a known price are counted as unpriced tokens, not guessed.

## The `/ccretro` skill

The repo is also a Claude Code plugin. Install it to get a `/ccretro` skill that runs the report, reads the JSON, checks each suggestion against your real config (resolving symlinks into a dotfiles repo if that's where your skills live), asks which ones to apply, then writes them. Nothing is committed or pushed unless you say so.

```text
/plugin marketplace add 0-draft/ccretro
/plugin install ccretro@ccretro
```

Run it monthly. `/schedule` can generate the report on a timer; applying changes always waits for you.

## Privacy

- Parsing and aggregation are local. Per-transcript summaries (counts, plus each prompt's first 400 characters) are kept in `~/.local/share/ccretro/archive.json` so later runs are fast and long-range retros survive Claude Code's cleanup. Delete that file to forget everything.
- The narrative step sends a digest (counts, project names, session titles and about 140 sampled prompts cut to 220 characters) to Claude through your own `claude -p`, the same path as any Claude Code session and the same as `/insights`. Read it first with `--dry-run`, narrow it with `-x`, or skip it with `--no-ai`.
- `claude -p` runs with no tools, no MCP servers and `--no-session-persistence`, so it doesn't land in your history or in the next report.
- The HTML never embeds raw prompts except the short "prompts you keep typing" list, which `--redact` removes. In `--redact` mode the sampled prompt text is still sent to Claude (it needs it to find themes) but never reaches the page; names are aliased before the digest is built, and if `claude -p` fails the fallback is built from the same redacted data.
- If the archive can't be written (read-only home, sandbox) ccretro warns and carries on. A format change or a corrupt archive is moved aside, never overwritten. Archives are kept per `CLAUDE_CONFIG_DIR`, so a second account's history never shows up in the first one's report.

## How the numbers are counted

- **Prompts**: messages you typed, including slash commands. Tool results, injected reminders, interrupts and headless (`claude -p` / SDK) sessions are excluded; prompts copied into resumed sessions are de-duplicated by UUID.
- **Active hours**: spans of transcript activity with gaps under 5 minutes, merged across all sessions, so three parallel sessions for an hour count as one hour.
- **Previous period**: the same length immediately before; omitted when it reaches back past the oldest data.
- **Tool error rate**: tool results flagged `is_error` over all tool calls.
- **Cache hit rate**: cache-read input tokens over all input tokens, main and subagent sessions.
- **Cost**: per assistant message, by model and pricing tier, deduplicated by message id; subagent sessions included.

## Development

```bash
npm ci
npm run check   # lint + build + test, same as CI
```

| Script | What it does |
| --- | --- |
| `npm run lint` | ESLint and markdownlint |
| `npm run build` | no compile step; checks what `npm pack` ships, that there are no runtime dependencies, that the plugin manifests and skills are well-formed, and that the CLI starts and fails cleanly on empty history |
| `npm test` | builds a fake `~/.claude` in a temp directory, runs the collector, analysis and CLI against it, and executes the page's script in a VM so UI regressions fail too |

CI runs lint (plus actionlint), build, and tests on Linux, macOS and Windows with Node 20, 22 and 24. Tests run without `npm ci` to prove the package needs nothing installed. CodeQL and dependency review run on PRs, and Dependabot proposes npm and GitHub Actions updates weekly after a 7-day cooldown. Actions are pinned by commit SHA.

Runtime has zero dependencies; ESLint and markdownlint are dev-only.

## License

MIT
