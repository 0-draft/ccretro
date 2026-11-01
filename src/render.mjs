// Self-contained HTML report. All charts are drawn client-side from embedded JSON.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function render({ reports, mainKey, insight, lang, generatedAt, cleanupDays = 30, excluded = 0 }) {
  // Raw prompts stay out of the file: the HTML is something people screenshot and share.
  const slim = Object.fromEntries(Object.entries(reports).map(([k, r]) => {
    const { prompts, sessions, ...rest } = r;
    return [k, rest];
  }));
  const data = JSON.stringify({ reports: slim, mainKey, insight, lang, generatedAt, cleanupDays, excluded }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccretro — Claude Code ${lang === 'ja' ? '振り返り' : 'Retrospective'}</title>
<style>${CSS}</style>
</head>
<body>
<main id="app"></main>
<script>const DATA = ${data};</script>
<script>${JS}</script>
</body>
</html>`;
}

const CSS = `
:root{
  --bg:#faf9f5; --panel:#ffffff; --ink:#1f1e1b; --muted:#6b6862; --faint:#a6a29a; --line:#e7e4dc;
  --accent:#c8622f; --accent-soft:#f3dfd2; --good:#4b7f52; --warn:#b5832b;
  --heat0:#f1efe9; --serif: "Iowan Old Style","Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",Georgia,serif;
  --sans: -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;
  --mono: ui-monospace,SFMono-Regular,Menlo,monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark){:root{
  --bg:#1f1e1c; --panel:#262522; --ink:#ecebe6; --muted:#a3a097; --faint:#6e6b64; --line:#38362f;
  --accent:#d9773f; --accent-soft:#4a3426; --heat0:#2c2b27; color-scheme: dark;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.7 var(--sans);-webkit-font-smoothing:antialiased}
main{max-width:980px;margin:0 auto;padding:40px 20px 80px}
header.top{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line);padding-bottom:14px}
.brand{font-weight:600;font-size:15px}.brand small{display:block;color:var(--muted);font-weight:400;font-size:12.5px}
.seg{display:inline-flex;max-width:100%;overflow-x:auto;white-space:nowrap;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--panel)}
.seg button{all:unset;cursor:pointer;padding:5px 12px;font-size:13px;color:var(--muted)}
.seg button[aria-pressed=true]{background:var(--ink);color:var(--bg)}
h1{font:400 34px/1.35 var(--serif);margin:42px 0 12px;letter-spacing:.01em}
.lead{color:var(--muted);max-width:44em;margin:0}
.note{font-size:12.5px;color:var(--faint);margin-top:8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:22px;margin:44px 0 10px}
.kpi b{display:block;font:400 28px/1.2 var(--serif)}.kpi span{font-size:12.5px;color:var(--muted)}
.kpi em{display:block;font-style:normal;font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums}
.st{font-size:11px;padding:1px 8px;border-radius:99px;border:1px solid var(--line);color:var(--muted)}.st.done{color:var(--good);border-color:currentColor}.st.partial{color:var(--warn);border-color:currentColor}
section{margin-top:56px}
h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600;margin:0 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:12px}
h2 .seg{text-transform:none;letter-spacing:0}
.chart svg{width:100%;height:auto;display:block}
.chart text{fill:var(--faint);font:11px var(--sans)}
.stack{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:6px 0 18px;background:var(--heat0)}
.legend{display:grid;grid-template-columns:1fr auto;gap:4px 24px;max-width:640px}
.legend .n{color:var(--muted);font-variant-numeric:tabular-nums;text-align:right}
.legend .d{grid-column:1/-1;color:var(--muted);font-size:13px;margin:-2px 0 10px 18px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:9px;vertical-align:1px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:14px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px;display:flex;flex-direction:column;gap:6px}
.card .k{font-size:12.5px;color:var(--muted);display:flex;gap:8px;align-items:center}
.card h3{font:500 17px/1.5 var(--serif);margin:0}
.card p{margin:0;color:var(--muted);font-size:14px}
.card .ev{font-size:13px;color:var(--ink);border-left:2px solid var(--accent-soft);padding-left:10px;margin-top:4px}
.card .row{display:flex;justify-content:flex-end;margin-top:auto;padding-top:8px}
.btn{all:unset;cursor:pointer;font-size:12.5px;padding:5px 12px;border-radius:7px;background:var(--ink);color:var(--bg)}
.btn.ghost{background:transparent;color:var(--muted);border:1px solid var(--line)}
.tag{font-size:11px;padding:1px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent)}
pre{font:12px/1.55 var(--mono);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;overflow:auto;max-height:240px;margin:6px 0 0;white-space:pre-wrap}
.bars{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:28px}
.bars h4{font-size:13px;margin:0 0 8px;font-weight:600}
.bar{display:grid;grid-template-columns:minmax(0,1fr) 44px;gap:8px;font-size:13px;align-items:center;margin:3px 0}
.bar .l{position:relative;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;padding:2px 6px;border-radius:4px}
.bar .l i{position:absolute;inset:0 auto 0 0;background:var(--accent-soft);z-index:0;border-radius:4px}
.bar .l span{position:relative}
.bar .v{text-align:right;color:var(--muted);font-variant-numeric:tabular-nums}
.empty{color:var(--faint);font-size:13px}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13.5px}
th{text-align:left;white-space:nowrap;font-weight:500;color:var(--muted);font-size:12px;padding:6px 10px;border-bottom:1px solid var(--line)}
td{padding:7px 10px;border-bottom:1px dashed var(--line);font-variant-numeric:tabular-nums;white-space:nowrap}
td.pn{position:relative;min-width:160px}td.pn i{position:absolute;inset:4px auto 4px 0;background:var(--accent-soft);border-radius:4px}td.pn span{position:relative;padding-left:6px}
td.tt{white-space:normal;color:var(--muted);font-size:12.5px;min-width:220px}
.fr{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px}
.fr div b{font:400 24px var(--serif);display:block}.fr div span{font-size:12.5px;color:var(--muted)}
.rep{list-style:none;padding:0;margin:0}.rep li{display:flex;gap:12px;padding:7px 0;border-bottom:1px dashed var(--line);font-size:14px}
.rep li b{min-width:40px;color:var(--accent);font-weight:600}
.heat{display:grid;grid-template-columns:28px repeat(24,1fr);gap:3px;font-size:10.5px;color:var(--faint)}
.heat i{aspect-ratio:1;border-radius:3px;background:var(--heat0)}
footer{margin-top:70px;color:var(--faint);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
@media (max-width:560px){h1{font-size:27px}.heat{gap:2px}}
`;

const JS = String.raw`
const ja = DATA.lang === 'ja';
const T = ja ? {
  title:'振り返り', sub:'Claude Code のローカル履歴から生成', periods:{'7':'過去7日','30':'過去1ヶ月','90':'過去3ヶ月','all':'全期間'},
  wd:['日曜日','月曜日','火曜日','水曜日','木曜日','金曜日','土曜日'],
  k:{wd:'最もアクティブな曜日',hr:'ピーク時間帯',ses:'セッション',pr:'指示した回数',days:'アクティブ日数',hrs:'利用時間',streak:'最長連続日数',proj:'プロジェクト'},
  activity:'Claude Code との利用時間', prompts:'指示', hours:'利用時間', heat:'曜日 × 時間', themes:'取り組んだこと', fluency:'スキルを広げる',
  fl:{delegation:'委任',description:'説明',discernment:'識別力',diligence:'勤勉さ'}, copy:'プロンプトをコピー', copied:'コピーしました',
  patterns:'目立った癖', next:'次にやるといいこと', usage:'使い方の内訳', tools:'ツール', skills:'Skills', agents:'サブエージェント', mcp:'MCP', cmds:'スラッシュコマンド', exts:'編集したファイル', models:'モデル',
  friction:'摩擦', fi:{interrupts:'中断',rejects:'ツール拒否',toolErrors:'ツールエラー',compacts:'コンパクション'}, per100:'/100指示', perCall:'% (ツール呼び出し比)',
  repeated:'何度も打っている指示', aiNote:(d)=>'文章は'+d+'のデータから生成。数値は期間切替に追従します。', none:'なし',
  snippet:'スニペット', projects:'プロジェクト別', pcol:{name:'プロジェクト',prompts:'指示',sessions:'セッション',hours:'時間',titles:'主なセッション'}, vsPrev:'前期間比', followUp:'前回の提案、その後', status:{done:'できた',partial:'一部',['not-yet']:'まだ',unclear:'不明'}, cache:'キャッシュヒット率', hrsUnit:'時間', foot:'データはこのマシンの ~/.claude/projects から読み取り、HTML に生のプロンプトは含めていません。', cleanup:(n)=>'Claude Code は '+n+' 日より古い履歴を削除する。それより前は、過去の実行時に ccretro が保存した要約だけ。', excl:(n)=>n+' 件のプロジェクトを除外。',
} : {
  title:'Retrospective', sub:'Generated from your local Claude Code history', periods:{'7':'Last 7 days','30':'Last month','90':'Last 3 months','all':'All time'},
  wd:['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
  k:{wd:'Most active day',hr:'Peak hour',ses:'Sessions',pr:'Prompts',days:'Active days',hrs:'Active hours',streak:'Best streak',proj:'Projects'},
  activity:'Activity', prompts:'Prompts', hours:'Hours', heat:'Weekday × hour', themes:'What you worked on', fluency:'Growing your skills',
  fl:{delegation:'Delegation',description:'Description',discernment:'Discernment',diligence:'Diligence'}, copy:'Copy prompt', copied:'Copied',
  patterns:'Patterns', next:'What to do next', usage:'How you used it', tools:'Tools', skills:'Skills', agents:'Subagents', mcp:'MCP', cmds:'Slash commands', exts:'Files edited', models:'Models',
  friction:'Friction', fi:{interrupts:'Interrupts',rejects:'Rejected tools',toolErrors:'Tool errors',compacts:'Compactions'}, per100:'/100 prompts', perCall:'% of tool calls',
  repeated:'Prompts you keep typing', aiNote:(d)=>'Narrative written from '+d+'. Numbers follow the period switch.', none:'none',
  snippet:'Snippet', projects:'By project', pcol:{name:'Project',prompts:'Prompts',sessions:'Sessions',hours:'Hours',titles:'Top sessions'}, vsPrev:'vs prev', followUp:'Last time\'s suggestions', status:{done:'done',partial:'partial',['not-yet']:'not yet',unclear:'unclear'}, cache:'Cache hit rate', hrsUnit:'h', foot:'Read from ~/.claude/projects on this machine. Raw prompts are not embedded in this file.', cleanup:(n)=>'Claude Code deletes history older than '+n+' days; anything earlier comes from summaries ccretro archived on previous runs.', excl:(n)=>n+' project filter(s) applied.',
};
const ICON = {
  delegation:'<path d="M7 11V6a1.5 1.5 0 013 0v4M10 10V4.5a1.5 1.5 0 013 0V10M13 10V5.5a1.5 1.5 0 013 0V13a6 6 0 01-6 6h-.5A5.5 5.5 0 014 14.6L2.8 12a1.4 1.4 0 012.4-1.4L7 13"/>',
  description:'<path d="M3 5.5C5.5 4 8 4 11 5.5v13C8 17 5.5 17 3 18.5zM19 5.5C16.5 4 14 4 11 5.5v13c3-1.5 5.5-1.5 8 0z"/>',
  discernment:'<circle cx="11" cy="11" r="7"/><circle cx="11" cy="11" r="3"/>',
  diligence:'<path d="M3 12l3 3 6-7M10 15l1 1 7-8"/>',
};
const svgIcon = (k) => '<svg width="16" height="16" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'+ICON[k]+'</svg>';
const PALETTE = ['#c8622f','#6c8ebf','#7a9a5b','#b58bb8','#c9a227','#5aa5a0','#a3a097'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = (n) => n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e4 ? (n/1e3).toFixed(0)+'k' : String(n);
const pl = (k) => T.periods[k] || (ja ? '過去' + k + '日' : 'Last ' + k + ' days');
const app = document.getElementById('app');
const state = { period: DATA.mainKey, metric: 'prompts' };
try { const s = JSON.parse(localStorage.getItem('ccretro') || '{}'); if (s.metric) state.metric = s.metric; } catch {}

function line(series, metric) {
  const W = 940, H = 220, P = { l: 34, r: 8, t: 12, b: 26 };
  const ys = series.map((d) => metric === 'hours' ? d.activeMs / 3600e3 : d.prompts);
  const max = Math.max(1, ...ys);
  const nice = (() => { const m = Math.pow(10, Math.floor(Math.log10(max))); return Math.ceil(max / m) * m; })();
  const x = (i) => P.l + (series.length <= 1 ? 0 : i * (W - P.l - P.r) / (series.length - 1));
  const y = (v) => H - P.b - v / nice * (H - P.t - P.b);
  const pts = ys.map((v, i) => [x(i), y(v)]);
  let d = '';
  pts.forEach((p, i) => {
    if (!i) { d = 'M' + p.join(','); return; }
    const [x0, y0] = pts[i - 1], cx = (x0 + p[0]) / 2;
    d += ' C' + cx + ',' + y0 + ' ' + cx + ',' + p[1] + ' ' + p[0] + ',' + p[1];
  });
  const grid = [0, nice / 2, nice].map((v) => '<line x1="'+P.l+'" x2="'+(W-P.r)+'" y1="'+y(v)+'" y2="'+y(v)+'" stroke="var(--line)"/><text x="'+(P.l-8)+'" y="'+(y(v)+4)+'" text-anchor="end">'+(metric==='hours'?(+v.toFixed(1)):Math.round(v))+'</text>').join('');
  const ticks = [0, .33, .66, 1].map((f) => Math.round(f * (series.length - 1))).filter((v, i, a) => a.indexOf(v) === i)
    .map((i) => { const s = series[i]; if (!s) return ''; const [, m, dd] = s.day.split('-'); return '<text x="'+x(i)+'" y="'+(H-6)+'" text-anchor="'+(i===0?'start':i===series.length-1?'end':'middle')+'">'+(ja? (+m)+'月'+(+dd)+'日' : m+'/'+dd)+'</text>'; }).join('');
  const area = d ? d + ' L' + x(series.length - 1) + ',' + y(0) + ' L' + x(0) + ',' + y(0) + ' Z' : '';
  const hits = series.map((s, i) => '<rect x="'+(x(i)-(W/series.length)/2)+'" y="0" width="'+(W/series.length)+'" height="'+H+'" fill="transparent"><title>'+s.day+' — '+(metric==='hours'?(s.activeMs/3600e3).toFixed(1)+T.hrsUnit:s.prompts+' '+T.prompts)+'</title></rect>').join('');
  return '<svg viewBox="0 0 '+W+' '+H+'" role="img" aria-label="'+T.activity+'">'+grid+'<path d="'+area+'" fill="var(--accent)" opacity=".08"/><path d="'+d+'" fill="none" stroke="var(--accent)" stroke-width="2"/>'+ticks+hits+'</svg>';
}

function heat(h) {
  const max = Math.max(1, ...h.flat());
  const order = [1, 2, 3, 4, 5, 6, 0];
  let s = '<div class="heat"><span></span>' + Array.from({ length: 24 }, (_, i) => '<span>' + (i % 6 === 0 ? i : '') + '</span>').join('');
  for (const w of order) {
    s += '<span>' + T.wd[w].slice(0, ja ? 1 : 3) + '</span>';
    s += h[w].map((v, hr) => '<i title="'+T.wd[w]+' '+hr+':00 — '+v+'" style="'+(v?'background:color-mix(in srgb,var(--accent) '+Math.round(15+85*v/max)+'%,var(--heat0))':'')+'"></i>').join('');
  }
  return s + '</div>';
}

function bars(title, rows) {
  if (!rows || !rows.length) return '<div><h4>'+title+'</h4><div class="empty">'+T.none+'</div></div>';
  const max = rows[0][1];
  return '<div><h4>'+title+'</h4>' + rows.map(([k, v]) => '<div class="bar"><div class="l" title="'+esc(k)+'"><i style="width:'+(v/max*100)+'%"></i><span>'+esc(k.replace(/^mcp__/,''))+'</span></div><div class="v">'+fmt(v)+'</div></div>').join('') + '</div>';
}

function copyBtn(text, label) {
  return '<button class="btn" data-copy="'+esc(text)+'">'+(label||T.copy)+'</button>';
}

function draw() {
  const r = DATA.reports[state.period];
  const ai = DATA.insight;
  const t = r.totals;
  const themes = (ai.themes || []);
  const tsum = themes.reduce((a, b) => a + (b.share || 0), 0) || 1;
  const fl = ai.fluency || {};
  let h = '';
  h += '<header class="top"><div class="brand">'+T.title+'<small>'+T.sub+'</small></div><div class="seg" role="group">' +
    Object.keys(DATA.reports).map((k) => '<button data-period="'+k+'" aria-pressed="'+(k===state.period)+'">'+pl(k)+'</button>').join('') + '</div></header>';
  h += '<h1>' + esc(ai.headline) + '</h1><p class="lead">' + esc(ai.summary) + '</p>';
  h += '<p class="note">' + T.aiNote(pl(DATA.mainKey)) + '</p>';
  const c = r.compare;
  const delta = (k) => {
    if (!c || !c[k]) return '';
    const { now, prev } = c[k];
    if (!prev) return '<em>'+T.vsPrev+' —</em>';
    const pct = Math.round((now - prev) / prev * 100);
    return '<em>'+T.vsPrev+' '+(pct > 0 ? '+' : '')+pct+'%</em>';
  };
  h += '<div class="kpis">' + [
    [T.wd[t.peakWeekday], T.k.wd], [t.peakHour + (ja ? '時' : ':00'), T.k.hr], [t.sessions, T.k.ses, 'sessions'], [t.prompts, T.k.pr, 'prompts'],
    [t.activeDays, T.k.days, 'activeDays'], [t.activeHours + T.hrsUnit, T.k.hrs, 'activeHours'], [t.projects, T.k.proj, 'projects'],
  ].map(([b, s, k]) => '<div class="kpi"><b>'+esc(b)+'</b><span>'+s+'</span>'+(k ? delta(k) : '')+'</div>').join('') + '</div>';

  h += '<section><h2>'+T.activity+'<span class="seg">' + ['prompts','hours'].map((m) => '<button data-metric="'+m+'" aria-pressed="'+(state.metric===m)+'">'+T[m]+'</button>').join('') + '</span></h2><div class="chart">' + line(r.series, state.metric) + '</div></section>';
  h += '<section><h2>'+T.heat+'</h2>' + heat(r.heat) + '</section>';

  if (themes.length) {
    h += '<section><h2>'+T.themes+'</h2><div class="stack">' + themes.map((x, i) => '<span title="'+esc(x.name)+'" style="width:'+(x.share/tsum*100)+'%;background:'+PALETTE[i%PALETTE.length]+'"></span>').join('') + '</div><div class="legend">' +
      themes.map((x, i) => '<div><span class="dot" style="background:'+PALETTE[i%PALETTE.length]+'"></span>'+esc(x.name)+'</div><div class="n">'+Math.round(x.share)+'%</div><div class="d">'+esc(x.detail)+'</div>').join('') + '</div></section>';
  }

  h += '<section><h2>'+T.fluency+'</h2><div class="cards">' + ['delegation','description','discernment','diligence'].map((k) => {
    const f = fl[k] || {};
    return '<div class="card"><div class="k">'+svgIcon(k)+T.fl[k]+'</div><h3>'+esc(f.title)+'</h3><p>'+esc(f.body)+'</p>' + (f.evidence ? '<div class="ev">'+esc(f.evidence)+'</div>' : '') + (f.prompt ? '<div class="row">'+copyBtn(f.prompt)+'</div>' : '') + '</div>';
  }).join('') + '</div></section>';

  if ((ai.followUp || []).length) {
    h += '<section><h2>'+T.followUp+'</h2><ul class="rep">' + ai.followUp.map((x) => '<li><span class="st '+esc(x.status)+'">'+esc(T.status[x.status] || x.status)+'</span><span><b style="color:var(--ink);font-weight:500">'+esc(x.title)+'</b><br><span style="color:var(--muted);font-size:13px">'+esc(x.evidence)+'</span></span></li>').join('') + '</ul></section>';
  }

  if ((ai.nextActions || []).length) {
    h += '<section><h2>'+T.next+'</h2><div class="cards">' + ai.nextActions.map((a, i) => '<div class="card"><div class="k"><span class="tag">'+esc(a.kind)+'</span>'+(i+1)+'</div><h3>'+esc(a.title)+'</h3><p>'+esc(a.why)+'</p><div class="ev">'+esc(a.how)+'</div>' + (a.snippet ? '<pre>'+esc(a.snippet)+'</pre><div class="row">'+copyBtn(a.snippet)+'</div>' : '') + '</div>').join('') + '</div></section>';
  }

  if ((ai.patterns || []).length) {
    h += '<section><h2>'+T.patterns+'</h2><div class="cards">' + ai.patterns.map((p) => '<div class="card"><h3>'+esc(p.title)+'</h3><p>'+esc(p.detail)+'</p></div>').join('') + '</div></section>';
  }

  if (r.projects.length) {
    const maxP = r.projects[0].prompts || 1;
    h += '<section><h2>'+T.projects+'</h2><div class="tbl"><table><thead><tr><th>'+T.pcol.name+'</th><th>'+T.pcol.prompts+'</th><th>'+T.pcol.sessions+'</th><th>'+T.pcol.hours+'</th><th>'+T.pcol.titles+'</th></tr></thead><tbody>' +
      r.projects.slice(0, 12).map((p) => '<tr><td class="pn"><i style="width:'+(p.prompts/maxP*100)+'%"></i><span>'+esc(p.name)+'</span></td><td>'+p.prompts+'</td><td>'+p.sessions+'</td><td>'+p.hours+'</td><td class="tt">'+esc((p.titles||[]).slice(0,3).join(' · '))+'</td></tr>').join('') + '</tbody></table></div></section>';
  }

  if (r.repeated.length) {
    h += '<section><h2>'+T.repeated+'</h2><ul class="rep">' + r.repeated.map((x) => '<li><b>×'+x.count+'</b><span>'+esc(x.text)+'</span></li>').join('') + '</ul></section>';
  }

  const f = r.friction;
  h += '<section><h2>'+T.friction+'</h2><div class="fr">' + ['interrupts','rejects','toolErrors','compacts'].map((k) => {
    const per = { interrupts: f.interruptsPer100+T.per100, rejects: f.rejectsPer100+T.per100, toolErrors: f.errorRate+T.perCall }[k];
    return '<div><b>'+f[k]+'</b><span>'+T.fi[k]+(per !== undefined ? ' · '+per : '')+'</span></div>';
  }).join('') + '<div><b>'+Math.round(t.cacheHitRate*100)+'%</b><span>'+T.cache+'</span></div></div></section>';

  const u = r.usage;
  h += '<section><h2>'+T.usage+'</h2><div class="bars">' + bars(T.tools, u.tools.slice(0, 10)) + bars(T.skills, u.skills) + bars(T.agents, u.agents) + bars(T.mcp, u.mcp) + bars(T.cmds, u.cmds) + bars(T.exts, u.exts) + bars(T.models, u.models) + '</div></section>';

  const meta = ai._meta || {};
  h += '<footer>ccretro · '+new Date(DATA.generatedAt).toLocaleString()+' · '+esc(meta.model)+(meta.costUsd ? ' · $'+meta.costUsd.toFixed(3) : '')+'<br>'+T.foot+' '+T.cleanup(DATA.cleanupDays)+(DATA.excluded ? ' '+T.excl(DATA.excluded) : '')+'</footer>';
  app.innerHTML = h;
}

app.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.period) { state.period = b.dataset.period; draw(); }
  else if (b.dataset.metric) { state.metric = b.dataset.metric; try { localStorage.setItem('ccretro', JSON.stringify({ metric: state.metric })); } catch {} draw(); }
  else if (b.dataset.copy !== undefined) {
    const done = () => { const o = b.textContent; b.textContent = T.copied; setTimeout(() => { b.textContent = o; }, 1400); };
    navigator.clipboard?.writeText(b.dataset.copy).then(done, () => {
      const ta = document.createElement('textarea'); ta.value = b.dataset.copy; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); done();
    });
  }
});
draw();
`;
