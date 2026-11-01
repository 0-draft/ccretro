#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { collect, dayKey } from '../src/collect.mjs';
import { analyze, inventory, projectName, compare } from '../src/analyze.mjs';
import { claudeHome } from '../src/collect.mjs';
import { digest, runClaude, heuristic } from '../src/insight.mjs';
import { render } from '../src/render.mjs';

const BUILTIN_AGENTS = new Set(['general-purpose', 'Explore', 'Plan', 'fork', 'claude-code-guide', 'statusline-setup']);
const BUILTIN_CMDS = new Set(['clear', 'compact', 'init', 'doctor', 'model', 'usage', 'cost', 'insights', 'resume', 'review', 'config', 'permissions', 'memory', 'mcp', 'agents', 'hooks', 'sandbox', 'status', 'help', 'login', 'logout', 'plan', 'context', 'export', 'rewind', 'loop', 'schedule', 'plugin', 'skills', 'recap']);
const PUBLIC_MCP = new Set(['playwright', 'github', 'context7']);

const HELP = `ccretro — a retrospective of your Claude Code usage, rendered as a local web page.

Usage: ccretro [options]

  -d, --days <n>     period the narrative is written for (default 30; 0 = all time)
  -l, --lang <ja|en> report language (default: from $LANG)
  -m, --model <id>   model for the narrative (passed to claude -p; default: your default)
      --no-ai        skip the claude -p call; numbers + rule-based suggestions only
      --dry-run      print the digest that would be sent to claude and exit
  -o, --out <file>   output HTML path (default: ~/.cache/ccretro/report-<date>.html)
      --no-open      don't open the browser
  (config.json may also set "pricing": {"model-id": {"in": 4, "out": 20, "read": 0.2}} in USD/MTok)
      --redact       share mode: hide project names, session titles and repeated
                     prompts in the HTML, and tell claude not to name anything
  -x, --exclude-project <name>
                     leave a project out of everything (stats, HTML, claude -p).
                     Repeatable. Matches the path under $HOME (e.g. "work/secret")
                     or the directory name. Also read from ~/.config/ccretro/config.json
                     as {"excludeProjects": ["..."]}
  -h, --help
`;

const { values: o } = parseArgs({
  options: {
    days: { type: 'string', short: 'd', default: '30' },
    lang: { type: 'string', short: 'l' },
    model: { type: 'string', short: 'm' },
    'no-ai': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    out: { type: 'string', short: 'o' },
    'no-open': { type: 'boolean' },
    redact: { type: 'boolean' },
    'exclude-project': { type: 'string', short: 'x', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
});
if (o.help) { process.stdout.write(HELP); process.exit(0); }

const days = Number(o.days);
if (!Number.isFinite(days) || days < 0) { console.error('--days must be a non-negative number'); process.exit(2); }
const mainKey = days === 0 ? 'all' : String(days);
const log = (s) => process.stderr.write(s);

log('scanning ~/.claude/projects … ');
const { sessions, fileCount, parsed, archived } = await collect({
  onProgress: (n, total) => { if (process.stderr.isTTY) log(`\rscanning ~/.claude/projects … ${n}/${total} `); },
});
log(`\rscanned ${fileCount} transcripts (${parsed} parsed, rest cached)${archived ? `, +${archived} archived after Claude Code deleted them` : ''}\n`);

// Projects to leave out entirely: flag + config file.
let config = {};
const configPath = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ccretro', 'config.json');
try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')) ?? {}; } catch (e) {
  if (e.code !== 'ENOENT') { console.error(`could not read ${configPath}: ${e.message}`); process.exit(2); }
}
const fromConfig = config.excludeProjects ?? [];
if (!Array.isArray(fromConfig) || fromConfig.some((x) => typeof x !== 'string' || !x)) {
  console.error(`${configPath}: "excludeProjects" must be an array of non-empty strings`);
  process.exit(2);
}
// Compare with forward slashes so "work/secret" also matches on Windows.
const slash = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
const excludes = [...fromConfig, ...(o['exclude-project'] || [])].map(slash);
const isExcluded = (cwd) => {
  if (!cwd) return false;
  const name = slash(projectName(cwd));
  const full = slash(cwd);
  const base = full.split('/').pop();
  return excludes.some((x) => name === x || full === x || base === x || name.startsWith(x + '/') || full.startsWith(x + '/'));
};
const ownerCwd = new Map(sessions.filter((s) => !s.isSub).map((s) => [s.sessionId, s.cwd]));
const kept = excludes.length ? sessions.filter((s) => !isExcluded(ownerCwd.get(s.sessionId) || s.cwd)) : sessions;
if (excludes.length) log(`excluded ${sessions.length - kept.length} transcripts matching: ${excludes.join(', ')}\n`);

const pricing = config.pricing ?? {};
if (typeof pricing !== 'object' || Array.isArray(pricing) || Object.values(pricing).some((p) => typeof p?.in !== 'number' || typeof p?.out !== 'number')) {
  console.error(`${configPath}: "pricing" must map model ids to {"in": n, "out": n, "read"?: n} (USD per million tokens)`);
  process.exit(2);
}

let cleanupDays = 30;
try { cleanupDays = JSON.parse(fs.readFileSync(path.join(claudeHome(), 'settings.json'), 'utf8')).cleanupPeriodDays ?? 30; } catch { /* default */ }
if (days === 0 || days > cleanupDays) {
  log(`note: Claude Code deletes transcripts older than cleanupPeriodDays (${cleanupDays}); ccretro only has what it archived on earlier runs. Raise it in ~/.claude/settings.json to keep more.\n`);
}

const reports = {};
for (const k of new Set(['7', '30', '90', 'all', mainKey])) reports[k] = analyze(kept, { days: k === 'all' ? 0 : Number(k), pricing });
const earliest = Math.min(...kept.filter((s) => s.start).map((s) => s.start));
for (const [k, r] of Object.entries(reports)) {
  if (k === 'all') continue;
  // Skip the comparison when the previous window predates the oldest data we have.
  const prevFrom = r.period.from - Number(k) * 86400e3;
  r.compare = earliest <= prevFrom + 86400e3 ? compare(r, analyze(kept, { days: Number(k), until: r.period.from, pricing })) : null;
}
const ordered = Object.fromEntries(['7', '30', '90', 'all', mainKey].filter((k, i, a) => a.indexOf(k) === i)
  .sort((a, b) => (a === 'all' ? 1e9 : +a) - (b === 'all' ? 1e9 : +b)).map((k) => [k, reports[k]]));
const main = reports[mainKey];
if (!main.totals.prompts) { console.error(`no prompts found in the last ${days || 'all'} days`); process.exit(1); }
// Language: flag > locale > whatever the user actually writes their prompts in.
const localeJa = /^ja/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
const jaShare = main.prompts.filter((p) => /[぀-ヿ一-鿿]/.test(p.text)).length / main.prompts.length;
const lang = o.lang || (localeJa || jaShare > 0.3 ? 'ja' : 'en');
let inv = inventory(main);

// Share mode: redact the data itself, before the digest, the fallback and the
// HTML are built from it, so no path can see the real names.
if (o.redact) {
  const L = lang === 'ja' ? { p: 'プロジェクト' } : { p: 'project' };
  const aliases = new Map();
  const aliasOf = (kind, name) => {
    const key = `${kind}:${name}`;
    if (!aliases.has(key)) aliases.set(key, `${kind === 'project' ? L.p : kind} ${[...aliases.keys()].filter((x) => x.startsWith(kind + ':')).length + 1}`);
    return aliases.get(key);
  };
  // Rank names over the widest period first so "skill 1" means the same skill in every tab.
  const all = reports.all;
  for (const [n] of all.usage.skills) aliasOf('skill', n);
  for (const p of all.projects) aliasOf('project', p.name);
  const mask = (rows, keep, kind) => rows.map(([k, v]) => [keep.has(k) ? k : aliasOf(kind, k), v]);
  const sumBy = (rows) => Object.entries(rows.reduce((o, [k, v]) => ({ ...o, [k]: (o[k] || 0) + v }), {})).sort((a, b) => b[1] - a[1]);
  for (const r of Object.values(reports)) {
    for (const p of r.projects) { p.name = aliasOf('project', p.name); p.titles = []; delete p.cwd; }
    for (const p of r.prompts) p.project = aliasOf('project', p.project);
    r.repeated = [];
    r.usage.skills = mask(r.usage.skills, new Set(), 'skill');
    r.usage.agents = mask(r.usage.agents, BUILTIN_AGENTS, 'agent');
    r.usage.cmds = mask(r.usage.cmds, BUILTIN_CMDS, 'command');
    r.usage.mcp = mask(r.usage.mcp, PUBLIC_MCP, 'mcp');
    r.usage.tools = sumBy(r.usage.tools.map(([k, v]) => [k.startsWith('mcp__') ? 'mcp tools' : k, v]));
    r.usage.exts = r.usage.exts.filter(([k]) => k.startsWith('.'));
  }
  inv = {
    globalClaudeMd: inv.globalClaudeMd, outputStyle: null, allowRules: inv.allowRules, hookEvents: inv.hookEvents,
    skills: inv.skills.map((n) => aliasOf('skill', n)), agents: inv.agents.map((n) => (BUILTIN_AGENTS.has(n) ? n : aliasOf('agent', n))),
    commands: inv.commands.map((n) => aliasOf('command', n)),
    projectClaudeMd: inv.projectClaudeMd.map((x) => ({ ...x, project: aliasOf('project', x.project) })),
  };
}

// Last run's suggestions, so this run can check whether they happened. Not in
// share mode (they were written with real names), and never mentioning a
// project that is now excluded.
const cacheRoot = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ccretro');
const lastPath = path.join(cacheRoot, 'last-insight.json');
let stored = null;
try { stored = JSON.parse(fs.readFileSync(lastPath, 'utf8')); } catch { /* first run */ }
let previous = stored && dayKey(Date.parse(stored.generatedAt)) === dayKey(Date.now()) ? stored.previous : stored;
if (previous?.nextActions) {
  const lower = excludes.map((x) => x.toLowerCase().split('/').pop());
  previous = { ...previous, nextActions: previous.nextActions.filter((a) => !lower.some((x) => JSON.stringify(a).toLowerCase().includes(x))) };
}
if (o.redact || !previous?.nextActions?.length) previous = null;

const text = digest(main, inv, lang, previous);
if (o['dry-run']) { process.stdout.write(text + '\n'); process.exit(0); }

let insight;
if (!o['no-ai']) {
  log(`writing the retrospective with claude -p (${text.length.toLocaleString()} chars of digest) … `);
  try {
    insight = await runClaude(text, { lang, model: o.model, redact: !!o.redact });
    log('done\n');
  } catch (e) {
    log(`failed: ${e.message}\nfalling back to --no-ai output\n`);
  }
}
insight ||= heuristic(main, inv, lang);

if (insight._meta?.model !== 'heuristic' && !o.redact) {
  try {
    fs.mkdirSync(cacheRoot, { recursive: true });
    const keepPrev = stored && dayKey(Date.parse(stored.generatedAt)) === dayKey(Date.now()) ? stored.previous : stored;
    fs.writeFileSync(lastPath, JSON.stringify({
      generatedAt: new Date().toISOString(), days, excludes, nextActions: insight.nextActions,
      previous: keepPrev && { generatedAt: keepPrev.generatedAt, days: keepPrev.days, nextActions: keepPrev.nextActions },
    }, null, 2));
  } catch (e) { log(`warning: could not save ${lastPath}: ${e.message}\n`); }
}

const now = new Date();
const stamp = dayKey(now.getTime()); // local date, not UTC
const out = path.resolve(o.out || path.join(cacheRoot, `report-${stamp}.html`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, render({ reports: ordered, mainKey, insight, lang, generatedAt: now.toISOString(), cleanupDays, excluded: excludes.length }));
const sidecar = { insight, totals: main.totals, usage: main.usage, friction: main.friction, period: main.period, generatedAt: now };
if (!o.redact) Object.assign(sidecar, { repeated: main.repeated, inventory: inv });
fs.writeFileSync(out.replace(/\.html$/, '.json'), JSON.stringify(sidecar, null, 2));
console.log(out);

if (!o['no-open']) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', out] : [out];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
