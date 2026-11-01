// Turn the numbers into a written retrospective by asking the user's own
// Claude Code (`claude -p`). Falls back to rule-based text when unavailable.
import { spawn } from 'node:child_process';

const WD = { ja: ['日', '月', '火', '水', '木', '金', '土'], en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] };

// In share mode the field descriptions must not ask for quotes or paths.
const schema = (redact) => ({
  type: 'object',
  required: ['headline', 'summary', 'themes', 'fluency', 'patterns', 'nextActions'],
  properties: {
    headline: { type: 'string', description: 'One short evocative line naming the period, like a chapter title.' },
    summary: { type: 'string', description: '2-4 sentences: what this person spent the period doing with Claude Code and the stance that showed.' },
    themes: {
      type: 'array', maxItems: 6,
      items: { type: 'object', required: ['name', 'share', 'detail'], properties: {
        name: { type: 'string' }, share: { type: 'number', description: 'percent of prompts, all themes sum to ~100' }, detail: { type: 'string' } } },
    },
    fluency: {
      type: 'object', required: ['delegation', 'description', 'discernment', 'diligence'],
      properties: Object.fromEntries(['delegation', 'description', 'discernment', 'diligence'].map((k) => [k, {
        type: 'object', required: ['title', 'body', 'evidence'],
        properties: {
          title: { type: 'string', description: 'one-line verdict' },
          body: { type: 'string', description: '1-2 sentences' },
          evidence: { type: 'string', description: redact ? 'a concrete number from the data; no names or quotes; empty if not enough signal' : 'a concrete number or quoted prompt from the data; empty if not enough signal' },
          prompt: { type: 'string', description: 'optional: a ready-to-paste prompt/instruction the user could use to improve this' },
        } }])),
    },
    patterns: {
      type: 'array', maxItems: 4, description: 'Notable habits — good or costly — grounded in the numbers.',
      items: { type: 'object', required: ['title', 'detail'], properties: { title: { type: 'string' }, detail: { type: 'string' } } },
    },
    followUp: {
      type: 'array', maxItems: 6,
      description: 'Only when PREVIOUS SUGGESTIONS are given: did each one happen? Judge from EXISTING SETUP, usage and repeated-prompt counts.',
      items: { type: 'object', required: ['title', 'status', 'evidence'], properties: {
        title: { type: 'string' }, status: { type: 'string', enum: ['done', 'partial', 'not-yet', 'unclear'] }, evidence: { type: 'string' } } },
    },
    nextActions: {
      type: 'array', minItems: 3, maxItems: 6,
      items: { type: 'object', required: ['title', 'why', 'how', 'kind'], properties: {
        title: { type: 'string' },
        why: { type: 'string', description: 'which observed data motivates it' },
        how: { type: 'string', description: redact ? 'concrete first step, described generically (no real paths or names)' : 'concrete first step: a file to create, a setting, a command' },
        kind: { type: 'string', enum: ['skill', 'hook', 'claude-md', 'permissions', 'subagent', 'workflow', 'habit', 'project'] },
        snippet: { type: 'string', description: redact ? 'optional generic template, no names from the data' : 'optional ready-to-use content (SKILL.md body, settings JSON, prompt)' },
      } },
    },
  },
});

export function digest(r, inv, lang, previous) {
  const wd = WD[lang] || WD.en;
  const sampleN = 140;
  const ps = r.prompts.filter((p) => !p.cmd);
  const step = Math.max(1, Math.floor(ps.length / sampleN));
  const sample = ps.filter((_, i) => i % step === 0).slice(0, sampleN)
    .map((p) => `[${p.project}] ${p.text.replace(/\s+/g, ' ').slice(0, 220)}`);
  const lines = [
    `PERIOD: last ${r.period.days || 'all'} days`,
    `TOTALS: sessions=${r.totals.sessions} prompts=${r.totals.prompts} activeDays=${r.totals.activeDays} bestStreak=${r.totals.bestStreak} activeHours(wall-clock, parallel sessions merged)=${r.totals.activeHours} claudeTurnHours(summed across parallel sessions)=${r.totals.claudeHours} toolCalls=${r.totals.toolCalls} projects=${r.totals.projects}`,
    `RHYTHM: peakWeekday=${wd[r.totals.peakWeekday]} peakHour=${r.totals.peakHour}:00 lateNight(0-5h)share=${(r.totals.lateNightShare * 100).toFixed(0)}%`,
    ...(r.compare ? [`VS PREVIOUS ${r.period.days} DAYS: ${Object.entries(r.compare).map(([k, v]) => `${k} ${v.prev}→${v.now}`).join(', ')}`] : []),
    `COST (API list-price equivalent, not what a subscription pays): $${r.totals.costUsd} — ${r.usage.costByModel.map(([k, v]) => `${k}=$${v}`).join(', ')}`,
    `CACHE: hitRate=${(r.totals.cacheHitRate * 100).toFixed(0)}% of input tokens served from prompt cache`,
    `PROMPT STYLE: medianChars=${r.style.medianChars} short(<=15 chars)=${(r.style.shareShort * 100).toFixed(0)}% long(>=400)=${(r.style.shareLong * 100).toFixed(0)}% withImages=${r.style.withImages}`,
    `DELEGATION: subagentCalls=${r.usage.delegation.agentCalls} skillCalls=${r.usage.delegation.skillCalls} toolCallsPerPrompt=${r.usage.delegation.toolCallsPerPrompt}`,
    `FRICTION: interrupts=${r.friction.interrupts} (${r.friction.interruptsPer100}/100 prompts) rejectedToolUses=${r.friction.rejects} toolErrors=${r.friction.toolErrors} (${r.friction.errorRate}% of tool calls) compactions=${r.friction.compacts}`,
    `TOOLS: ${r.usage.tools.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `SKILLS USED: ${r.usage.skills.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `SUBAGENTS USED: ${r.usage.agents.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `MCP: ${r.usage.mcp.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `SLASH COMMANDS: ${r.usage.cmds.map(([k, v]) => `${k}=${v}`).join(', ') || 'none'}`,
    `MODELS: ${r.usage.models.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `PERMISSION MODES: ${r.usage.permissionModes.map(([k, v]) => `${k}=${v}`).join(', ') || 'n/a'}`,
    `FILES EDITED BY EXT: ${r.usage.exts.map(([k, v]) => `${k}=${v}`).join(', ')}`,
    '',
    'PROJECTS (prompts / sessions / active hours / session titles):',
    ...r.projects.slice(0, 15).map((p) => `- ${p.name}: ${p.prompts} / ${p.sessions} / ${p.hours}h — ${p.titles.slice(0, 6).join(' | ')}`),
    '',
    'REPEATED PROMPTS (normalised, count, #projects):',
    ...r.repeated.map((x) => `- "${x.text.replace(/\s+/g, ' ')}" ×${x.count} in ${x.projects} projects`),
    '',
    'EXISTING SETUP (do not suggest what already exists):',
    `global CLAUDE.md=${inv.globalClaudeMd} outputStyle=${inv.outputStyle} allowRules=${inv.allowRules} hookEvents=${inv.hookEvents.join(',') || 'none'}`,
    `user skills: ${inv.skills.join(', ') || 'none'}`,
    `user subagents: ${inv.agents.join(', ') || 'none'}`,
    `user commands: ${inv.commands.join(', ') || 'none'}`,
    `per-project: ${inv.projectClaudeMd.map((p) => `${p.project}(CLAUDE.md=${p.claudeMd ? 'y' : 'n'},skills=${p.projectSkills})`).join(', ')}`,
    ...(previous ? ['', `PREVIOUS SUGGESTIONS (from ${previous.generatedAt.slice(0, 10)}):`,
      ...previous.nextActions.map((a) => `- [${a.kind}] ${a.title} — ${a.how}`)] : []),
    '',
    `SAMPLED USER PROMPTS (${sample.length} of ${ps.length}, chronological):`,
    ...sample,
  ];
  return lines.join('\n');
}

// Share mode gets its own prompt rather than a rule appended to the normal one,
// so nothing in it asks for quotes.
const SHARE = (lang) => `You write a personal retrospective of someone's Claude Code usage that they will share publicly. Input is aggregated local stats plus sampled prompts; names in it are already aliased ("project 3", "skill 2").
Rules:
- Write in ${lang === 'ja' ? 'Japanese (natural, plain, warm but not gushing; no AI-ish flourishes, no emoji)' : 'English (plain, warm but not gushing, no emoji)'}.
- Never name or hint at specific projects, repositories, organisations, companies, products, people, file paths, URLs, session titles, or custom skill/agent/command names, even if they appear inside sampled prompts. Never quote a prompt. Use the aliases or generic descriptions ("an OSS security research project").
- Ground claims in numbers from the data. If signal is thin, say so.
- "fluency" follows the 4D AI Fluency framework: delegation, description, discernment, diligence.
- nextActions stay generic and reusable; snippets must not contain anything from the data.
- Leave followUp empty. Be concise. Do not lecture.`;

const SYSTEM = (lang, redact) => redact ? SHARE(lang) : `You write a personal retrospective of someone's Claude Code usage, like a thoughtful monthly review. Input is aggregated local stats plus sampled prompts.
Rules:
- Write in ${lang === 'ja' ? 'Japanese (natural, plain, warm but not gushing; no AI-ish flourishes, no emoji)' : 'English (plain, warm but not gushing, no emoji)'}.
- Ground every claim in the data. Quote short prompt fragments or numbers as evidence. If signal is thin for an item, say so plainly instead of inventing.
- "fluency" follows the 4D AI Fluency framework: delegation (what they hand to Claude vs keep), description (how well they convey goals/context/constraints), discernment (how they evaluate and push back on output), diligence (responsibility: verification, security, what they ship).
- nextActions must be specific to THIS person: e.g. turn a repeated prompt into a skill or hook, add permission allow rules for friction, add CLAUDE.md to busy projects lacking one, use subagents/plan mode where it would help. Never suggest something listed under EXISTING SETUP. Include a snippet when it saves them work.
- If PREVIOUS SUGGESTIONS are given, fill followUp honestly (a skill that now exists = done; the repeated prompt still frequent = not-yet). Don't re-suggest something done; if one is not-yet and still matters, you may carry it forward with a smaller first step.
- Do not mention personal names of third parties that appear in prompts; refer to them generically.
- Do not lecture. Be concise.`;

export function runClaude(text, { lang, model, redact = false, timeoutMs = 300e3 }) {
  // followUp stays optional in the schema; the system prompt says when to fill it.
  return new Promise((resolve, reject) => {
    const args = ['-p', '--output-format', 'json', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--json-schema', JSON.stringify(schema(redact)), '--system-prompt', SYSTEM(lang, redact)];
    if (model) args.push('--model', model);
    const child = spawn(process.env.CCRETRO_CLAUDE_BIN || 'claude', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('claude -p timed out')); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${(err || out).slice(0, 400)}`));
      try {
        const j = JSON.parse(out);
        if (j.is_error) return reject(new Error(String(j.result).slice(0, 400)));
        const so = j.structured_output ?? JSON.parse(String(j.result).replace(/^```(?:json)?\s*|\s*```$/g, ''));
        resolve({ ...so, _meta: { model: model || 'default', costUsd: j.total_cost_usd, ms: j.duration_ms } });
      } catch (e) { reject(new Error(`could not parse claude output: ${e.message}`)); }
    });
    child.stdin.end(text);
  });
}

// Deterministic fallback so the report is useful without an LLM call.
export function heuristic(r, inv, lang) {
  const ja = lang === 'ja';
  const wd = WD[lang] || WD.en;
  const top = r.projects[0];
  const acts = [];
  for (const x of r.repeated.slice(0, 2)) {
    acts.push({ kind: 'skill', title: ja ? `「${x.text.slice(0, 24)}」を skill / コマンド化` : `Turn "${x.text.slice(0, 24)}" into a skill`,
      why: ja ? `${x.count} 回同じ指示を打っている` : `typed ${x.count} times`, how: ja ? '~/.claude/skills/<name>/SKILL.md に手順を書く' : 'write the steps into ~/.claude/skills/<name>/SKILL.md' });
  }
  if (r.friction.rejectsPer100 > 3) acts.push({ kind: 'permissions', title: ja ? '承認拒否の多いツールを整理' : 'Tune permissions', why: `${r.friction.rejects} rejects`, how: ja ? '/permissions で allow/deny を見直す' : 'review allow/deny via /permissions' });
  for (const p of inv.projectClaudeMd.filter((x) => !x.claudeMd).slice(0, 1)) {
    acts.push({ kind: 'claude-md', title: ja ? `${p.project} に CLAUDE.md を置く` : `Add CLAUDE.md to ${p.project}`, why: ja ? '利用の多いプロジェクトなのに未設定' : 'busy project without one', how: ja ? 'そのディレクトリで /init' : 'run /init there' });
  }
  if (r.usage.delegation.agentCalls === 0) acts.push({ kind: 'subagent', title: ja ? 'サブエージェントに調査を任せる' : 'Delegate research to subagents', why: ja ? '期間中のサブエージェント利用 0' : 'no subagent use', how: ja ? '広い調査は "Explore エージェントで" と頼む' : 'ask for the Explore agent on broad searches' });
  const thin = { title: ja ? '手がかりが少ない' : 'Not enough signal', body: ja ? 'AI 生成をオフにしているため数値のみ。' : 'AI narrative disabled; numbers only.', evidence: '' };
  return {
    headline: ja ? `${r.totals.prompts} 回話しかけた ${r.period.days || '全'} 日間` : `${r.totals.prompts} prompts over ${r.period.days || 'all'} days`,
    summary: ja
      ? `${r.totals.projects} プロジェクトで ${r.totals.sessions} セッション。いちばん多かったのは ${top?.name || '-'}。${wd[r.totals.peakWeekday]}曜の ${r.totals.peakHour} 時台がピーク。`
      : `${r.totals.sessions} sessions across ${r.totals.projects} projects, mostly ${top?.name || '-'}. Peak: ${wd[r.totals.peakWeekday]} ${r.totals.peakHour}:00.`,
    themes: r.projects.slice(0, 5).map((p) => ({ name: p.name, share: r.totals.prompts ? Math.round((p.prompts / r.totals.prompts) * 100) : 0, detail: p.titles.slice(0, 2).join(' / ') })),
    fluency: { delegation: thin, description: thin, discernment: thin, diligence: thin },
    patterns: [],
    nextActions: acts,
    _meta: { model: 'heuristic' },
  };
}
