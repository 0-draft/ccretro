#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { collect, dayKey } from '../src/collect.mjs';
import { analyze, inventory } from '../src/analyze.mjs';
import { digest, runClaude, heuristic } from '../src/insight.mjs';
import { render } from '../src/render.mjs';

const HELP = `ccretro — a retrospective of your Claude Code usage, rendered as a local web page.

Usage: ccretro [options]

  -d, --days <n>     period the narrative is written for (default 30; 0 = all time)
  -l, --lang <ja|en> report language (default: from $LANG)
  -m, --model <id>   model for the narrative (passed to claude -p; default: your default)
      --no-ai        skip the claude -p call; numbers + rule-based suggestions only
      --dry-run      print the digest that would be sent to claude and exit
  -o, --out <file>   output HTML path (default: ~/.cache/ccretro/report-<date>.html)
      --no-open      don't open the browser
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
    help: { type: 'boolean', short: 'h' },
  },
});
if (o.help) { process.stdout.write(HELP); process.exit(0); }

const days = Number(o.days);
if (!Number.isFinite(days) || days < 0) { console.error('--days must be a non-negative number'); process.exit(2); }
const mainKey = days === 0 ? 'all' : String(days);
const log = (s) => process.stderr.write(s);

log('scanning ~/.claude/projects … ');
const { sessions, fileCount, parsed } = await collect({
  onProgress: (n, total) => { if (process.stderr.isTTY) log(`\rscanning ~/.claude/projects … ${n}/${total} `); },
});
log(`\rscanned ${fileCount} transcripts (${parsed} parsed, rest cached)\n`);

const reports = {};
for (const k of new Set(['7', '30', '90', 'all', mainKey])) reports[k] = analyze(sessions, { days: k === 'all' ? 0 : Number(k) });
const ordered = Object.fromEntries(['7', '30', '90', 'all', mainKey].filter((k, i, a) => a.indexOf(k) === i)
  .sort((a, b) => (a === 'all' ? 1e9 : +a) - (b === 'all' ? 1e9 : +b)).map((k) => [k, reports[k]]));
const main = reports[mainKey];
if (!main.totals.prompts) { console.error(`no prompts found in the last ${days || 'all'} days`); process.exit(1); }
// Language: flag > locale > whatever the user actually writes their prompts in.
const localeJa = /^ja/i.test(process.env.LC_ALL || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale);
const jaShare = main.prompts.filter((p) => /[\u3040-\u30ff\u4e00-\u9fff]/.test(p.text)).length / main.prompts.length;
const lang = o.lang || (localeJa || jaShare > 0.3 ? 'ja' : 'en');
const inv = inventory(main);
const text = digest(main, inv, lang);

if (o['dry-run']) { process.stdout.write(text + '\n'); process.exit(0); }

let insight;
if (o['no-ai']) insight = heuristic(main, inv, lang);
else {
  log(`writing the retrospective with claude -p (${text.length.toLocaleString()} chars of digest) … `);
  try {
    insight = await runClaude(text, { lang, model: o.model });
    log('done\n');
  } catch (e) {
    log(`failed: ${e.message}\nfalling back to --no-ai output\n`);
    insight = heuristic(main, inv, lang);
  }
}

const now = new Date();
const stamp = dayKey(now.getTime()); // local date, not UTC
const out = path.resolve(o.out || path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ccretro', `report-${stamp}.html`));
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, render({ reports: ordered, mainKey, insight, lang, generatedAt: now.toISOString() }));
fs.writeFileSync(out.replace(/\.html$/, '.json'), JSON.stringify({ insight, totals: main.totals, generatedAt: now }, null, 2));
console.log(out);

if (!o['no-open']) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', out] : [out];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
