// Scan ~/.claude/projects/**/*.jsonl and reduce each transcript to a small,
// cacheable summary. Nothing here leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';

const CACHE_VERSION = 4;
const IDLE_MS = 5 * 60e3; // gaps longer than this end an activity span
const PROMPT_MAX = 400;

export function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function cacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
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
    tools: {}, skills: {}, agents: {}, models: {}, exts: {}, cmds: {},
  };
}
const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

async function summarize(file) {
  const isSub = file.includes(`${path.sep}subagents${path.sep}`);
  const s = {
    file, isSub, sessionId: null, cwd: null, title: null, entrypoint: null,
    start: null, end: null, prompts: [], days: {}, permissionModes: {}, spans: [],
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
        if (m.model && m.model !== '<synthetic>') inc(dd.models, m.model);
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

export async function collect({ onProgress } = {}) {
  const root = path.join(claudeHome(), 'projects');
  const files = listTranscripts(root);
  const cdir = cacheDir();
  fs.mkdirSync(cdir, { recursive: true });
  const cfile = path.join(cdir, 'index.json');
  let cache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(cfile, 'utf8'));
    if (raw.v === CACHE_VERSION && raw.tz === new Date().getTimezoneOffset()) cache = raw.files;
  } catch { /* cold cache */ }

  const next = {};
  const out = [];
  let parsed = 0;
  const todo = [];
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch { continue; }
    const key = `${st.size}:${st.mtimeMs}`;
    if (cache[f]?.key === key) { next[f] = cache[f]; out.push(cache[f].s); }
    else todo.push({ f, key });
  }
  // Parse a few files at a time; IO-bound so modest concurrency helps.
  const CONC = 8;
  let i = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (i < todo.length) {
      const { f, key } = todo[i++];
      try {
        const s = await summarize(f);
        next[f] = { key, s };
        out.push(s);
      } catch { /* unreadable file: skip */ }
      parsed++;
      onProgress?.(parsed, todo.length);
    }
  }));
  fs.writeFileSync(cfile, JSON.stringify({ v: CACHE_VERSION, tz: new Date().getTimezoneOffset(), files: next }));
  return { sessions: out, fileCount: files.length, parsed };
}
