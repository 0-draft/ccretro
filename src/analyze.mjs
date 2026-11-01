// Aggregate per-file summaries into a report for one period.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { dayKey, claudeHome } from './collect.mjs';
import { costOf, canonical } from './pricing.mjs';

const add = (dst, src) => { for (const [k, v] of Object.entries(src || {})) dst[k] = (dst[k] || 0) + v; };
const top = (o, n = 10) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n);
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

export function projectName(cwd) {
  if (!cwd) return '(unknown)';
  const home = os.homedir();
  if (cwd === home) return '~';
  if (cwd.startsWith(home + path.sep)) return cwd.slice(home.length + 1);
  return cwd;
}

// Normalise a prompt so "全部やれ。" and "全部やれよ" land together.
function norm(t) {
  return t.toLowerCase().replace(/https?:\/\/\S+/g, '<url>').replace(/\/\S+/g, '<path>')
    .replace(/[\s。、.,!！?？ー〜~「」"'`]+/g, '').replace(/(よ|ね|な|ぜ|ぞ|え)+$/u, '').slice(0, 60);
}

// Merge overlapping [start,end] spans (parallel sessions count once).
function union(spans) {
  const xs = spans.filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [a, b] of xs) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}
const spanMs = (xs) => xs.reduce((a, [x, y]) => a + (y - x), 0);

// `until` lets the CLI compute the previous period for comparison.
export function analyze(sessions, { days, until, pricing = {} }) {
  const now = until ?? Date.now();
  const toKey = dayKey(now);
  const from = days ? now - days * 86400e3 : 0;
  const fromKey = days ? dayKey(from) : '0000';

  const daily = {};
  const agg = { tools: {}, skills: {}, agents: {}, models: {}, exts: {}, cmds: {} };
  const byModel = {};
  const tot = { prompts: 0, interrupts: 0, rejects: 0, toolErrors: 0, compacts: 0, turnMs: 0, tok: { in: 0, out: 0, cr: 0, cc: 0 } };
  const heat = Array.from({ length: 7 }, () => Array(24).fill(0));
  const projects = {};
  const prompts = [];
  const sessionList = [];
  const perm = {};

  const seen = new Set();
  const allSpans = [];
  const projSpans = {};
  const byId = new Map();
  for (const s of sessions) {
    if (!s.isSub && s.sessionId) byId.set(s.sessionId, s);
  }

  for (const s of sessions) {
    let touched = false;
    for (const [k, d] of Object.entries(s.days)) {
      // With `until`, the end day belongs to the following period, so it is exclusive.
      if (k < fromKey || (until ? k >= toKey : k > toKey)) continue;
      touched = true;
      const dd = (daily[k] ||= { prompts: 0, activeMs: 0, sessions: 0, tokens: 0 });
      dd.tokens += d.tok.in + d.tok.out + d.tok.cr + d.tok.cc;
      for (const f of ['interrupts', 'rejects', 'toolErrors', 'compacts', 'turnMs']) tot[f] += d[f];
      for (const f of ['in', 'out', 'cr', 'cc']) tot.tok[f] += d.tok[f];
      let dayCost = 0;
      for (const [m, t] of Object.entries(d.byModel || {})) {
        const b = (byModel[canonical(m)] ||= { in: 0, out: 0, cr: 0, cc5: 0, cc1h: 0 });
        for (const f of Object.keys(b)) b[f] += t[f];
        dayCost += costOf(m, t, pricing) || 0;
      }
      dd.cost = (dd.cost || 0) + dayCost;
      for (const f of Object.keys(agg)) add(agg[f], d[f]);
    }
    if (!touched) continue;
    const owner = s.isSub ? byId.get(s.sessionId) : s;
    const pname = projectName(owner?.cwd || s.cwd);
    const pj = (projects[pname] ||= { name: pname, cwd: owner?.cwd || s.cwd, prompts: 0, sessions: 0, activeMs: 0, titles: [] });
    const clipped = (s.spans || []).map(([a, b]) => [Math.max(a, from), Math.min(b, now)]).filter(([a, b]) => b > a);
    allSpans.push(...clipped);
    (projSpans[pname] ||= []).push(...clipped);
    if (s.isSub) continue;
    Object.entries(s.permissionModes).forEach(([k, v]) => { perm[k] = (perm[k] || 0) + v; });
    // Headless runs (claude -p / SDK) are automation, not the person typing.
    const headless = /^sdk/.test(s.entrypoint || '');
    const ps = headless ? [] : s.prompts.filter((p) => p.t >= from && p.t < now && !(p.u && seen.has(p.u)));
    ps.forEach((p) => p.u && seen.add(p.u));
    pj.prompts += ps.length;
    if (ps.length) {
      pj.sessions++;
      if (s.title && pj.titles.length < 12) pj.titles.push(s.title);
      sessionList.push({ id: s.sessionId, project: pname, title: s.title, start: s.start, end: s.end, prompts: ps.length });
      const k0 = dayKey(ps[0].t);
      if (daily[k0]) daily[k0].sessions++;
    }
    for (const p of ps) {
      const d = new Date(p.t);
      (daily[dayKey(p.t)] ||= { prompts: 0, activeMs: 0, sessions: 0, tokens: 0 }).prompts++;
      tot.prompts++;
      heat[d.getDay()][d.getHours()]++;
      prompts.push({ ...p, project: pname });
    }
  }

  // Wall-clock activity: union of all session spans, split at local midnight.
  const active = union(allSpans);
  for (const [a0, b] of active) {
    let a = a0;
    while (a < b) {
      const dt = new Date(a);
      const next = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() + 1).getTime();
      const e = Math.min(b, next);
      (daily[dayKey(a)] ||= { prompts: 0, activeMs: 0, sessions: 0, tokens: 0 }).activeMs += e - a;
      a = e;
    }
  }
  for (const [n, xs] of Object.entries(projSpans)) if (projects[n]) projects[n].activeMs = spanMs(union(xs));

  // Calendar-filled daily series
  const series = [];
  const firstKey = days ? fromKey : Object.keys(daily).sort()[0];
  if (firstKey) {
    const [y, m, d] = firstKey.split('-').map(Number);
    for (let c = new Date(y, m - 1, d); dayKey(c.getTime()) <= dayKey(now); c.setDate(c.getDate() + 1)) {
      const k = dayKey(c.getTime());
      series.push({ day: k, ...(daily[k] || { prompts: 0, activeMs: 0, sessions: 0, tokens: 0 }) });
    }
  }

  const activeDays = series.filter((x) => x.prompts > 0).length;
  let streak = 0, best = 0;
  for (const x of series) { streak = x.prompts > 0 ? streak + 1 : 0; best = Math.max(best, streak); }
  const wdTotals = heat.map((r) => r.reduce((a, b) => a + b, 0));
  const hrTotals = Array.from({ length: 24 }, (_, h) => heat.reduce((a, r) => a + r[h], 0));
  const peakWd = wdTotals.indexOf(Math.max(...wdTotals));
  const peakHr = hrTotals.indexOf(Math.max(...hrTotals));
  const lateNight = hrTotals.slice(0, 5).reduce((a, b) => a + b, 0);

  // Prompt style
  const lens = prompts.filter((p) => !p.cmd).map((p) => p.len).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const short = lens.filter((l) => l <= 15).length;
  const long = lens.filter((l) => l >= 400).length;
  const withImg = prompts.filter((p) => p.img).length;

  // Repeated prompts → skill / hook candidates
  const groups = {};
  for (const p of prompts) {
    if (p.cmd) continue;
    const k = norm(p.text);
    if (k.length < 2) continue;
    (groups[k] ||= { sample: p.text.slice(0, 120), n: 0, projects: new Set() }).n++;
    groups[k].projects.add(p.project);
  }
  const repeated = Object.values(groups).filter((g) => g.n >= 3)
    .sort((a, b) => b.n - a.n).slice(0, 15)
    .map((g) => ({ text: g.sample, count: g.n, projects: g.projects.size }));

  const mcp = {};
  for (const [k, v] of Object.entries(agg.tools)) {
    const m = k.match(/^mcp__(.+?)__/);
    if (m) mcp[m[1]] = (mcp[m[1]] || 0) + v;
  }
  const toolCalls = sum(agg.tools);
  const per100 = (n) => (tot.prompts ? Math.round((n / tot.prompts) * 1000) / 10 : 0);

  let costTotal = 0;
  let unpricedTokens = 0;
  const costByModel = [];
  for (const [m, t] of Object.entries(byModel)) {
    const c = costOf(m, t, pricing);
    if (c === null) unpricedTokens += t.in + t.out + t.cr + t.cc5 + t.cc1h;
    else { costTotal += c; costByModel.push([m, Math.round(c * 100) / 100]); }
  }
  costByModel.sort((a, b) => b[1] - a[1]);

  const projList = Object.values(projects).filter((p) => p.prompts > 0)
    .sort((a, b) => b.prompts - a.prompts);

  return {
    period: { days, from: days ? from : series[0] ? Date.parse(series[0].day) : now, to: now },
    totals: {
      sessions: sessionList.length, prompts: tot.prompts, activeDays, bestStreak: best,
      activeHours: Math.round((spanMs(active) / 3600e3) * 10) / 10,
      costUsd: Math.round(costTotal * 100) / 100,
      unpricedTokens,
      cacheHitRate: (tot.tok.in + tot.tok.cr + tot.tok.cc) ? tot.tok.cr / (tot.tok.in + tot.tok.cr + tot.tok.cc) : 0,
      claudeHours: Math.round((tot.turnMs / 3600e3) * 10) / 10,
      tokens: tot.tok, toolCalls, peakWeekday: peakWd, peakHour: peakHr,
      lateNightShare: tot.prompts ? lateNight / prompts.length : 0,
      projects: projList.length,
    },
    series, heat,
    projects: projList.slice(0, 20).map((p) => ({ ...p, hours: Math.round((p.activeMs / 3600e3) * 10) / 10 })),
    usage: {
      costByModel,
      tools: top(agg.tools, 15), skills: top(agg.skills, 15), agents: top(agg.agents, 10),
      mcp: top(mcp, 10), models: top(agg.models, 6), exts: top(agg.exts, 10), cmds: top(agg.cmds, 12),
      permissionModes: top(perm, 6),
      delegation: { agentCalls: sum(agg.agents), skillCalls: sum(agg.skills), toolCallsPerPrompt: tot.prompts ? Math.round((toolCalls / tot.prompts) * 10) / 10 : 0 },
    },
    friction: {
      interrupts: tot.interrupts, rejects: tot.rejects, toolErrors: tot.toolErrors, compacts: tot.compacts,
      interruptsPer100: per100(tot.interrupts), rejectsPer100: per100(tot.rejects),
      errorRate: toolCalls ? Math.round((tot.toolErrors / toolCalls) * 1000) / 10 : 0,
    },
    style: {
      medianChars: median, shareShort: lens.length ? short / lens.length : 0,
      shareLong: lens.length ? long / lens.length : 0, withImages: withImg,
    },
    repeated,
    prompts, sessions: sessionList,
  };
}

// What the user has already set up, so suggestions don't repeat it.
export function inventory(report) {
  const home = claudeHome();
  const ls = (p) => { try { return fs.readdirSync(p).filter((n) => !n.startsWith('.')); } catch { return []; } };
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')); } catch { /* none */ }
  const hooks = Object.keys(settings.hooks || {});
  const projectClaudeMd = report.projects.slice(0, 12).map((p) => ({
    project: p.name,
    claudeMd: !!p.cwd && (fs.existsSync(path.join(p.cwd, 'CLAUDE.md')) || fs.existsSync(path.join(p.cwd, '.claude', 'CLAUDE.md'))),
    projectSkills: p.cwd ? ls(path.join(p.cwd, '.claude', 'skills')).length : 0,
  }));
  return {
    globalClaudeMd: fs.existsSync(path.join(home, 'CLAUDE.md')),
    skills: ls(path.join(home, 'skills')),
    agents: ls(path.join(home, 'agents')).map((n) => n.replace(/\.md$/, '')),
    commands: ls(path.join(home, 'commands')).map((n) => n.replace(/\.md$/, '')),
    hookEvents: hooks,
    allowRules: (settings.permissions?.allow || []).length,
    outputStyle: settings.outputStyle || null,
    projectClaudeMd,
  };
}

// Change vs the previous period of the same length, for the KPI row.
export function compare(cur, prev) {
  const pick = (r) => ({
    prompts: r.totals.prompts, sessions: r.totals.sessions, activeHours: r.totals.activeHours,
    activeDays: r.totals.activeDays, projects: r.totals.projects, costUsd: r.totals.costUsd,
    interruptsPer100: r.friction.interruptsPer100, errorRate: r.friction.errorRate,
    agentCalls: r.usage.delegation.agentCalls, skillCalls: r.usage.delegation.skillCalls,
  });
  const a = pick(cur), b = pick(prev);
  if (!prev.totals.prompts) return null;
  return Object.fromEntries(Object.keys(a).map((k) => [k, { now: a[k], prev: b[k] }]));
}
