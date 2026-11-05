// Scan ~/.claude/projects/**/*.jsonl and reduce each transcript to a small,
// cacheable summary. Nothing here leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const CACHE_VERSION = 5;
// Bump when summarize() learns a new field. Cached summaries of transcripts
// still on disk are re-parsed; ones Claude Code already deleted are kept as-is
// (bumping CACHE_VERSION instead would park the whole archive aside).
const PARSE_REV = 1;
const IDLE_MS = 5 * 60e3; // gaps longer than this end an activity span
const PROMPT_MAX = 400;

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Durable, not a cache: summaries of transcripts Claude Code has since deleted
// (cleanupPeriodDays) live only here, which is what makes long-range retros possible.
export function dataDir() {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'ccretro');
}

export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function listTranscripts(root) {
  const out = [];
  const walk = (dir, depth) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && depth < 4) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

// Text the user actually typed, or null for harness-injected content.
function promptText(content) {
  if (typeof content === 'string') return { text: content, img: false };
  if (!Array.isArray(content)) return null;
  let text = '';
  let img = false;
  let hasToolResult = false;
  for (const b of content) {
    if (b?.type === 'text') text += (text ? '\n' : '') + b.text;
    else if (b?.type === 'image') img = true;
    else if (b?.type === 'tool_result') hasToolResult = true;
  }
  if (hasToolResult) return null;
  return { text, img };
}

const NOISE = [
  /^<system-reminder>/, /^<local-command-/, /^<bash-(stdout|stderr|input)>/,
  /^Base directory for this skill/, /^Another Claude session sent a message/,
  /^Caveat: The messages below/, /^This session is being continued/,
  /^<task-notification>/, /^\[Request interrupted/, /^Your .* usage limit/,
];

function newDay() {
  return {
    prompts: 0, interrupts: 0, rejects: 0, toolErrors: 0, compacts: 0, turnMs: 0,
    tok: { in: 0, out: 0, cr: 0, cc: 0 },
    byModel: {}, // model[@tier] → { in, out, cr, cc5, cc1h } for cost estimates
    tools: {}, skills: {}, agents: {}, models: {}, exts: {}, cmds: {},
  };
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

async function summarize(file) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const s = {
    file, isSub, sessionId: null, cwd: null, title: null, entrypoint: null,
    start: null, end: null, prompts: [], days: {}, permissionModes: {}, spans: [],
    prs: {}, // PR url → { t: first seen, repo }
  };
  const seenMsg = new Set();
  const day = (ms) => (s.days[dayKey(ms)] ||= newDay());

  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    // Cheap prefilter: request blobs and snapshots are huge and useless here.
    if (line.startsWith('{"type":"api-request') || line.startsWith('{"type":"file-history')) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const t = d.type;
    if (t === 'ai-title' && d.aiTitle) { s.title = d.aiTitle; continue; }
    if (t === 'summary' && d.summary && !s.title) { s.title = d.summary; continue; }
    if (t === 'permission-mode' && d.permissionMode) { inc(s.permissionModes, d.permissionMode); continue; }
    const ms = d.timestamp ? Date.parse(d.timestamp) : NaN;
    if (Number.isNaN(ms)) continue;
    s.sessionId ||= d.sessionId;
    if (d.cwd) s.cwd ||= d.cwd;
    if (d.entrypoint) s.entrypoint ||= d.entrypoint;
    if (s.start === null || ms < s.start) s.start = ms;
    if (s.end === null || ms > s.end) s.end = ms;
    const last = s.spans[s.spans.length - 1];
    if (last && ms >= last[0] && ms - last[1] <= IDLE_MS) last[1] = Math.max(last[1], ms);
    else s.spans.push([ms, ms]);

    if (t === 'pr-link') {
      // Written when a session creates or links a PR, then repeated on refresh.
      if (d.prUrl && !(s.prs[d.prUrl]?.t <= ms)) s.prs[d.prUrl] = { t: ms, repo: d.prRepository || null };
      continue;
    }

    if (t === 'system') {
      if (d.subtype === 'turn_duration' && d.durationMs) day(ms).turnMs += d.durationMs;
      else if (d.subtype === 'compact_boundary') day(ms).compacts++;
      continue;
    }

    if (t === 'assistant') {
      const m = d.message || {};
      const dd = day(ms);
      if (m.id && !seenMsg.has(m.id)) {
        seenMsg.add(m.id);
        const u = m.usage || {};
        dd.tok.in += u.input_tokens || 0;
        dd.tok.out += u.output_tokens || 0;
        dd.tok.cr += u.cache_read_input_tokens || 0;
        dd.tok.cc += u.cache_creation_input_tokens || 0;
        if (m.model && m.model !== '<synthetic>') {
          inc(dd.models, m.model);
          const cc = u.cache_creation_input_tokens || 0;
          const cc1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
          const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + cc;
          // Pricing tiers that change the rate: fast mode, and Haiku 5.5 above 100K.
          let key = m.model;
          if (u.speed === 'fast') key += '@fast';
          else if (/haiku-5-5/.test(m.model) && prompt > 100_000) key += '@>100k';
          const bm = (dd.byModel[key] ||= { in: 0, out: 0, cr: 0, cc5: 0, cc1h: 0 });
          bm.in += u.input_tokens || 0;
          bm.out += u.output_tokens || 0;
          bm.cr += u.cache_read_input_tokens || 0;
          bm.cc1h += cc1h;
          bm.cc5 += cc - cc1h;
        }
      }
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b?.type !== 'tool_use') continue;
        inc(dd.tools, b.name);
        const inp = b.input || {};
        if (b.name === 'Skill' && inp.skill) inc(dd.skills, inp.skill);
        if ((b.name === 'Agent' || b.name === 'Task')) inc(dd.agents, inp.subagent_type || 'general-purpose');
        if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(b.name) && inp.file_path) {
          const ext = path.extname(inp.file_path).toLowerCase() || path.basename(inp.file_path);
          inc(dd.exts, ext);
        }
      }
      continue;
    }

    if (t === 'user') {
      const m = d.message || {};
      const c = m.content;
      // tool results: rejections / errors
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== 'tool_result') continue;
          const txt = typeof b.content === 'string' ? b.content
            : Array.isArray(b.content) ? b.content.map((x) => x?.text || '').join('') : '';
          if (/doesn't want to proceed|was rejected|denied by the user/i.test(txt)) day(ms).rejects++;
          else if (b.is_error) day(ms).toolErrors++;
        }
      }
      const p = promptText(c);
      if (!p) continue;
      const text = p.text.trim();
      if (/^\[Request interrupted by user/.test(text)) { day(ms).interrupts++; continue; }
      if (isSub || d.isSidechain || d.isMeta || d.isCompactSummary) continue;
      const cmd = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
      if (cmd) {
        inc(day(ms).cmds, cmd[1].trim());
        const args = text.match(/<command-args>([\s\S]*?)<\/command-args>/);
        s.prompts.push({ u: d.uuid, t: ms, text: `/${cmd[1].trim()} ${(args?.[1] || '').trim()}`.slice(0, PROMPT_MAX), cmd: cmd[1].trim(), len: text.length });
        day(ms).prompts++;
        continue;
      }
      if (!text && !p.img) continue;
      if (NOISE.some((r) => r.test(text))) continue;
      day(ms).prompts++;
      s.prompts.push({ u: d.uuid, t: ms, text: text.slice(0, PROMPT_MAX), len: text.length, img: p.img || undefined });
    }
  }
  return s;
}

export async function collect({ onProgress, warn = (m) => process.stderr.write(`warning: ${m}\n`) } = {}) {
  const root = path.join(claudeHome(), 'projects');
  const files = listTranscripts(root);
  const cdir = dataDir();
  const cfile = path.join(cdir, 'archive.json');
  let cache = {};
  let sameTz = true;
  let raw = null;
  try { raw = fs.readFileSync(cfile, 'utf8'); } catch { /* first run */ }
  if (raw !== null) {
    try {
      const j = JSON.parse(raw);
      if (j.v === CACHE_VERSION) { cache = j.files; sameTz = j.tz === new Date().getTimezoneOffset(); }
      else {
        // Never silently drop archived history: park it next to the new file.
        const keep = path.join(cdir, `archive.v${j.v}.json`);
        try { fs.renameSync(cfile, keep); } catch { /* best effort */ }
        warn(`archive format changed (v${j.v} → v${CACHE_VERSION}); old archive kept at ${keep}`);
      }
    } catch (e) {
      const keep = path.join(cdir, `archive.corrupt-${Date.now()}.json`);
      try { fs.renameSync(cfile, keep); } catch { /* best effort */ }
      warn(`could not parse ${cfile} (${e.message}); moved it to ${keep}`);
    }
  }

  const next = {};
  const out = [];
  let parsed = 0;
  let archived = 0;
  const keepArchived = (f) => {
    if (!cache[f]) return;
    next[f] = { ...cache[f], gone: true };
    out.push(cache[f].s);
    archived++;
  };
  const todo = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { keepArchived(f); continue; } // deleted mid-scan
    const key = `${st.size}:${st.mtimeMs}`;
    if (sameTz && cache[f]?.key === key && (cache[f].rev || 0) >= PARSE_REV) { next[f] = cache[f]; out.push(cache[f].s); }
    else todo.push({ f, key });
  }
  // Keep summaries of transcripts that are gone from disk, but only ones that
  // belonged to this Claude config dir: another account's history must not leak in.
  const live = new Set(files);
  const prefix = root + path.sep;
  for (const f of Object.keys(cache)) if (!live.has(f) && f.startsWith(prefix)) keepArchived(f);
  // Entries from other config dirs stay in the file untouched.
  for (const [f, e] of Object.entries(cache)) if (!f.startsWith(prefix)) next[f] = e;

  // Parse a few files at a time; IO-bound so modest concurrency helps.
  const CONC = 8;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const { f, key } = todo[i++];
      try {
        const s = await summarize(f);
        next[f] = { key, rev: PARSE_REV, s };
        out.push(s);
      } catch { keepArchived(f); }
      parsed++;
      onProgress?.(parsed, todo.length);
    }
  }));
  try {
    fs.mkdirSync(cdir, { recursive: true });
    const tmpFile = `${cfile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify({ v: CACHE_VERSION, tz: new Date().getTimezoneOffset(), files: next }));
    fs.renameSync(tmpFile, cfile);
  } catch (e) {
    warn(`could not write ${cfile} (${e.message}); the report still works, but history won't be archived`);
  }
  return { sessions: out, fileCount: files.length, parsed, archived };
}
