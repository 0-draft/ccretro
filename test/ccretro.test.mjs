import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawnSync } from 'node:child_process';

// Point every module at a throwaway ~/.claude and cache before importing them.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccretro-test-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.XDG_CACHE_HOME = path.join(tmp, 'cache');
process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
process.env.XDG_DATA_HOME = path.join(tmp, 'data');

const { collect, dayKey } = await import('../src/collect.mjs');
const { analyze, compare } = await import('../src/analyze.mjs');
const { digest, heuristic } = await import('../src/insight.mjs');
const { render } = await import('../src/render.mjs');

const H = 3600e3;
const base = Date.now() - 2 * 86400e3; // two days ago, inside every period
const iso = (ms) => new Date(ms).toISOString();

function writeSession(dir, id, cwd, records) {
  const p = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', dir);
  fs.mkdirSync(p, { recursive: true });
  const lines = records.map((r) => JSON.stringify({ sessionId: id, cwd, entrypoint: 'cli', ...r }));
  fs.writeFileSync(path.join(p, `${id}.jsonl`), lines.join('\n') + '\n');
}
const user = (t, text, uuid, extra = {}) => ({ type: 'user', uuid, timestamp: iso(t), message: { role: 'user', content: text }, ...extra });
const asst = (t, id, tools = [], usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 90 }) => ({
  type: 'assistant', timestamp: iso(t),
  message: { id, model: 'claude-test', usage, content: tools.map((name, i) => ({ type: 'tool_use', id: `${id}-${i}`, name, input: name === 'Skill' ? { skill: 'demo' } : name === 'Edit' ? { file_path: '/x/a.ts' } : {} })) },
});
const result = (t, isError, text = 'ok') => ({ type: 'user', timestamp: iso(t), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: isError, content: text }] } });

const home = os.homedir();
writeSession('-a', 's1', path.join(home, 'proj-a'), [
  { type: 'ai-title', aiTitle: 'Title A' },
  user(base, '全部やれ。', 'u1'),
  asst(base + 1000, 'm1', ['Bash', 'Edit']),
  asst(base + 1500, 'm1', ['Skill']), // same message id split across blocks: tokens counted once
  result(base + 2000, true, 'boom'),
  result(base + 2500, false, "The user doesn't want to proceed with this tool use."),
  user(base + 60e3, '[Request interrupted by user]', 'u-int'),
  user(base + 120e3, '全部やれよ', 'u2'),
  user(base + 130e3, '<system-reminder>ignore me</system-reminder>', 'u-sys'),
  user(base + 140e3, '<command-name>/clear</command-name><command-args></command-args>', 'u-cmd'),
  user(base + 4 * 60e3, '全部やれ', 'u3'),
  user(base + 3 * H, 'later prompt', 'u4'), // > 5 min gap: new span
]);
// A resumed copy repeating u1 must not double count; parallel span must merge.
writeSession('-a', 's2', path.join(home, 'proj-a'), [
  user(base, '全部やれ。', 'u1'),
  user(base + 2 * 60e3, 'parallel work', 'u5'),
]);
writeSession('-b', 's3', path.join(home, 'secret'), [user(base, 'private stuff', 'u6')]);
writeSession('-c', 's4', path.join(home, 'proj-c'), [user(base, 'headless', 'u7', { entrypoint: 'sdk-cli' })]);

const { sessions } = await collect();

test('counts typed prompts only, de-duplicated across resumed sessions', () => {
  const r = analyze(sessions, { days: 7 });
  // u1 u2 u3 u4 (s1) + /clear + u5 (s2) + u6 (secret); not: interrupt, reminder, dup u1, headless u7
  assert.equal(r.totals.prompts, 7);
  assert.equal(r.usage.cmds.find(([k]) => k === 'clear')?.[1], 1);
  assert.equal(r.friction.interrupts, 1);
  assert.equal(r.friction.rejects, 1);
  assert.equal(r.friction.toolErrors, 1);
});

test('tool, skill and token accounting', () => {
  const r = analyze(sessions, { days: 7 });
  assert.deepEqual(Object.fromEntries(r.usage.tools), { Bash: 1, Edit: 1, Skill: 1 });
  assert.deepEqual(r.usage.skills, [['demo', 1]]);
  assert.deepEqual(r.usage.exts, [['.ts', 1]]);
  assert.equal(r.totals.tokens.out, 5); // m1 counted once
  assert.equal(r.totals.cacheHitRate, 0.9);
});

test('active hours merge parallel sessions and split on idle gaps', () => {
  const r = analyze(sessions, { days: 7 });
  // s1: [base, base+4min] and [base+3h]; s2: [base, base+2min] overlaps s1
  assert.equal(r.totals.activeHours, Math.round((4 * 60e3 / H) * 10) / 10);
});

test('repeated prompts group spelling variants', () => {
  const r = analyze(sessions, { days: 7 });
  assert.equal(r.repeated[0].count, 3);
  assert.match(r.repeated[0].text, /全部やれ/);
});

test('period window excludes data outside it', () => {
  const r = analyze(sessions, { days: 1 });
  assert.equal(r.totals.prompts, 0);
  const prev = analyze(sessions, { days: 7, until: base - 1 });
  assert.equal(prev.totals.prompts, 0);
  assert.equal(compare(analyze(sessions, { days: 7 }), prev), null);
});

test('series covers every calendar day of the period', () => {
  const r = analyze(sessions, { days: 7 });
  assert.equal(r.series.at(-1).day, dayKey(Date.now()));
  assert.ok(r.series.length >= 7 && r.series.length <= 8);
});

test('CLI --exclude-project removes a project from the digest', () => {
  const run = (...a) => execFileSync(process.execPath, ['bin/ccretro.mjs', '--dry-run', '-d', '7', ...a], { encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore'] });
  assert.match(run(), /private stuff/);
  const out = run('-x', 'secret');
  assert.doesNotMatch(out, /private stuff|secret/);
});

test('HTML script runs and renders every section without raw prompts', () => {
  const r = analyze(sessions, { days: 7 });
  r.compare = { prompts: { now: 7, prev: 5 }, sessions: { now: 3, prev: 0 } };
  const insight = {
    ...heuristic(r, { projectClaudeMd: [] }, 'ja'),
    patterns: [{ title: 'p', detail: 'd' }],
    followUp: [{ title: 'did it', status: 'done', evidence: 'skill exists' }, { title: 'x', status: 'not-yet', evidence: 'e' }],
    nextActions: [{ kind: 'skill', title: 'make <skill>', why: 'w', how: 'h', snippet: 'a "quoted" \' snippet' }],
  };
  for (const lang of ['ja', 'en']) {
    const html = render({ reports: { 7: r }, mainKey: '7', insight, lang, generatedAt: new Date().toISOString(), cleanupDays: 30, excluded: 1 });
    assert.doesNotMatch(html, /private stuff|parallel work/);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const app = { innerHTML: '', addEventListener() {} };
    const ctx = { document: { getElementById: () => app }, localStorage: { getItem: () => null, setItem() {} }, navigator: {}, console };
    vm.createContext(ctx);
    for (const s of scripts) vm.runInContext(s, ctx);
    for (const needle of ['make &lt;skill&gt;', 'did it', '+40%', 'kpi', '<svg', 'heat', '<table>', 'Title A']) assert.ok(app.innerHTML.includes(needle), `${lang}: missing ${needle}`);
  }
});

test('digest carries previous suggestions for follow-up', () => {
  const r = analyze(sessions, { days: 7 });
  const d = digest(r, { skills: [], agents: [], commands: [], hookEvents: [], projectClaudeMd: [] }, 'en', { generatedAt: '2026-10-01T00:00:00Z', nextActions: [{ kind: 'skill', title: 'Old idea', how: 'do it' }] });
  assert.match(d, /PREVIOUS SUGGESTIONS \(from 2026-10-01\)/);
  assert.match(d, /Old idea/);
});

test('summaries survive Claude Code deleting the transcript', async () => {
  const f = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-c', 's4.jsonl');
  writeSession('-d', 's9', path.join(home, 'proj-d'), [user(base, 'soon deleted', 'u9')]);
  await collect();
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-d'), { recursive: true });
  const again = await collect();
  assert.equal(again.archived, 1);
  assert.ok(again.sessions.some((s) => s.prompts.some((p) => p.text === 'soon deleted')));
  assert.ok(fs.existsSync(f));
});

test('--redact hides project names, titles and repeated prompts in the HTML', () => {
  const out = path.join(tmp, 'r.html');
  execFileSync(process.execPath, ['bin/ccretro.mjs', '--no-ai', '--no-open', '--redact', '-d', '7', '-o', out], { env: process.env, stdio: 'ignore' });
  const html = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(html, /proj-a|Title A|secret|全部やれ|"demo"/);
  assert.match(html, /project 1|プロジェクト 1/);
});

// ---- regressions from review ----
const cli = (args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, ['bin/ccretro.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...extraEnv } });
  return r;
};

test('--redact stays redacted when claude -p fails (fallback path)', () => {
  const out = path.join(tmp, 'fail.html');
  const r = cli(['--redact', '--no-open', '-d', '7', '-o', out], { CCRETRO_CLAUDE_BIN: process.platform === 'win32' ? 'nonexistent-claude-bin' : 'false' });
  assert.match(r.stderr, /falling back/);
  for (const f of [out, out.replace(/\.html$/, '.json')]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /proj-a|Title A|secret|全部やれ|"demo"/, f);
  }
});

test('--redact digest is aliased and carries no previous suggestions', () => {
  fs.mkdirSync(path.join(process.env.XDG_CACHE_HOME, 'ccretro'), { recursive: true });
  fs.writeFileSync(path.join(process.env.XDG_CACHE_HOME, 'ccretro', 'last-insight.json'), JSON.stringify({ generatedAt: '2020-01-01T00:00:00Z', nextActions: [{ kind: 'skill', title: 'Add CLAUDE.md to secret', how: 'run /init in ~/secret' }] }));
  const d = cli(['--dry-run', '--redact', '-d', '7']).stdout;
  // Sampled prompt text is still sent (the model needs it for themes) under the
  // no-quoting share prompt; names, titles, paths and previous suggestions are not.
  assert.doesNotMatch(d, /proj-a|Title A|secret|PREVIOUS|REPEATED PROMPTS \(normalised, count, #projects\):\n-/);
  assert.match(d, /project 1|プロジェクト 1/);
});

test('excluded projects never reach claude via previous suggestions', () => {
  const d = cli(['--dry-run', '-d', '7', '-x', 'secret']).stdout;
  assert.doesNotMatch(d, /secret/);
  const keep = cli(['--dry-run', '-d', '7']).stdout;
  assert.match(keep, /PREVIOUS SUGGESTIONS/);
  fs.rmSync(path.join(process.env.XDG_CACHE_HOME, 'ccretro', 'last-insight.json'));
});

test('excludeProjects in config must be an array of strings', () => {
  const dir = path.join(process.env.XDG_CONFIG_HOME, 'ccretro');
  fs.mkdirSync(dir, { recursive: true });
  for (const bad of ['"secret"', 'null', '[1]']) {
    fs.writeFileSync(path.join(dir, 'config.json'), `{"excludeProjects": ${bad}}`);
    assert.equal(cli(['--dry-run', '-d', '7']).status, bad === 'null' ? 0 : 2, bad);
  }
  fs.writeFileSync(path.join(dir, 'config.json'), '{"excludeProjects": ["secret"]}');
  assert.doesNotMatch(cli(['--dry-run', '-d', '7']).stdout, /private stuff/);
  fs.rmSync(path.join(dir, 'config.json'));
});

test('archive survives a format change and a corrupt file, and stays per config dir', async () => {
  const data = path.join(tmp, 'data2');
  const env = { XDG_DATA_HOME: data };
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = data;
  const warns = [];
  await collect({ warn: (m) => warns.push(m) });
  const file = path.join(data, 'ccretro', 'archive.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...j, v: 1 }));
  await collect({ warn: (m) => warns.push(m) });
  assert.ok(fs.existsSync(path.join(data, 'ccretro', 'archive.v1.json')));
  fs.writeFileSync(file, '{not json');
  await collect({ warn: (m) => warns.push(m) });
  assert.ok(fs.readdirSync(path.join(data, 'ccretro')).some((n) => n.startsWith('archive.corrupt-')));
  assert.equal(warns.length, 2);

  // Another config dir with no transcripts must not inherit this one's archive.
  const prevHome = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'other-claude');
  const other = await collect({ warn() {} });
  assert.equal(other.sessions.length, 0);
  process.env.CLAUDE_CONFIG_DIR = prevHome;
  const back = await collect({ warn() {} });
  assert.ok(back.sessions.length > 0, 'original entries kept for their own config dir');
  process.env.XDG_DATA_HOME = prev;
  void env;
});

test('unwritable data dir warns instead of crashing', async () => {
  const blocker = path.join(tmp, 'blocker');
  fs.writeFileSync(blocker, 'not a dir');
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = blocker; // mkdir under a file fails on every OS
  const warns = [];
  const r = await collect({ warn: (m) => warns.push(m) });
  assert.ok(r.sessions.length > 0);
  assert.match(warns.join(), /could not write/);
  process.env.XDG_DATA_HOME = prev;
});

test('previous-period comparison does not count the boundary day twice', () => {
  const r = analyze(sessions, { days: 7 });
  const prev = analyze(sessions, { days: 7, until: r.period.from });
  assert.equal(prev.usage.delegation.skillCalls + r.usage.delegation.skillCalls, analyze(sessions, { days: 14 }).usage.delegation.skillCalls);
});

test('exclude matches forward-slash names regardless of OS separators', () => {
  writeSession('-w', 's10', path.join(home, 'work', 'nested'), [user(base, 'nested work prompt', 'u10')]);
  const d = cli(['--dry-run', '-d', '7', '-x', 'work/nested']).stdout;
  assert.doesNotMatch(d, /nested work prompt/);
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-w'), { recursive: true });
});

test('pricing: canonical ids, cache tiers, fast mode, unknown models', async () => {
  const { costOf, canonical } = await import('../src/pricing.mjs');
  assert.equal(canonical('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.equal(canonical('us.anthropic.claude-opus-5-5'), 'claude-opus-5-5');
  const M = 1e6;
  // 1M each of input, output, cache read, 5m write, 1h write on Opus 5.5 ($4/$20, read $0.20)
  assert.equal(costOf('claude-opus-5-5', { in: M, out: M, cr: M, cc5: M, cc1h: M }), 4 + 20 + 0.2 + 5 + 8);
  assert.equal(costOf('claude-opus-5-5@fast', { in: M, out: 0, cr: 0, cc5: 0, cc1h: 0 }), 8);
  assert.equal(costOf('claude-unknown-9', { in: M, out: 0, cr: 0, cc5: 0, cc1h: 0 }), null);
  assert.equal(costOf('claude-unknown-9', { in: M, out: 0, cr: 0, cc5: 0, cc1h: 0 }, { 'claude-unknown-9': { in: 1, out: 2 } }), 1);
});

test('cost estimate flows from transcripts to totals, splitting cache TTLs', async () => {
  writeSession('-p', 's11', path.join(home, 'priced'), [
    user(base, 'priced prompt', 'u11'),
    { type: 'assistant', timestamp: iso(base + 1000), message: { id: 'mp', model: 'claude-opus-5-5', content: [],
      usage: { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } } } },
  ]);
  const { sessions: s2 } = await collect({ warn() {} });
  const r = analyze(s2, { days: 7 });
  // $4 input + 1M 5m write ($5) + 1M 1h write ($8)
  assert.equal(r.usage.costByModel.find(([m]) => m === 'claude-opus-5-5')?.[1], 17);
  assert.ok(r.totals.unpricedTokens > 0, 'claude-test fixture model has no price');
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-p'), { recursive: true });
});

test('pull requests: deduplicated across refreshes and sessions, in the period first linked', async () => {
  const pr = (t, n, repo = 'acme/app') => ({ type: 'pr-link', timestamp: iso(t), prNumber: n, prRepository: repo, prUrl: `https://github.com/${repo}/pull/${n}` });
  writeSession('-q', 's12', path.join(home, 'prs'), [
    user(base, 'open a pr', 'u12'),
    pr(base + 1000, 1), pr(base + 60e3, 1), // refresh of the same PR
    pr(base + 2000, 2, 'acme/lib'),
    pr(base - 20 * 86400e3, 3), // first linked long before this week
  ]);
  writeSession('-q', 's13', path.join(home, 'prs'), [user(base + 3 * H, 'follow up', 'u13'), pr(base + 3 * H, 1), pr(base + 3 * H, 3)]);
  const { sessions: s2 } = await collect({ warn() {} });
  const r = analyze(s2, { days: 7 });
  assert.equal(r.totals.prs, 2);
  assert.equal(r.totals.prRepos, 2);
  assert.deepEqual(Object.fromEntries(r.usage.prRepos), { 'acme/app': 1, 'acme/lib': 1 });
  assert.equal(analyze(s2, { days: 30 }).totals.prs, 3);
  assert.equal(analyze(s2, { days: 14, until: base - 7 * 86400e3 }).totals.prs, 1);
  assert.match(digest(r, { skills: [], agents: [], commands: [], hookEvents: [], projectClaudeMd: [] }, 'en'), /PULL REQUESTS .*: 2 across 2 repos — acme\/app=1, acme\/lib=1/);

  const out = path.join(tmp, 'pr.html');
  execFileSync(process.execPath, ['bin/ccretro.mjs', '--no-ai', '--no-open', '--redact', '-d', '7', '-o', out], { env: process.env, stdio: 'ignore' });
  for (const f of [out, out.replace(/\.html$/, '.json')]) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /acme/, f);
  assert.match(fs.readFileSync(out.replace(/\.html$/, '.json'), 'utf8'), /"repo 1"/);
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', '-q'), { recursive: true });
});

test('cached summaries from an older parser are re-read, deleted ones are kept', async () => {
  const file = path.join(process.env.XDG_DATA_HOME, 'ccretro', 'archive.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const e of Object.values(j.files)) { delete e.rev; delete e.s.prs; }
  fs.writeFileSync(file, JSON.stringify(j));
  const r = await collect({ warn() {} });
  assert.equal(r.parsed, r.fileCount);
  assert.ok(r.archived >= 1, 'summaries of deleted transcripts are not dropped');
  assert.ok(r.sessions.filter((s) => fs.existsSync(s.file)).every((s) => s.prs));
  // An archived summary without PR data makes earlier periods incomplete.
  const old = { ...r.sessions[0], prs: undefined, end: Date.now() - 10 * 86400e3 };
  const all = [...r.sessions.filter((x) => x.prs), old];
  const cur = analyze(all, { days: 7 });
  assert.equal(cur.totals.prsComplete, true);
  const prev = analyze(all, { days: 7, until: cur.period.from });
  assert.equal(prev.totals.prsComplete, false);
  assert.ok(!('prs' in (compare(cur, prev) || {})));
});
