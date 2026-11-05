// "Build" check for a zero-build package: what ships, whether it starts, and
// whether the plugin manifests are well-formed.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fail = (msg) => { console.error(`✖ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✔ ${msg}`);

// 1. Package contents
const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8', shell: process.platform === 'win32' }));
// npm <= 11 prints an array of packages; npm 12 prints an object keyed by package name.
const [pack] = Array.isArray(packed) ? packed : Object.values(packed);
const files = pack.files.map((f) => f.path);
for (const need of ['bin/ccretro.mjs', 'src/collect.mjs', 'src/analyze.mjs', 'src/insight.mjs', 'src/render.mjs', 'skills/ccretro/SKILL.md', '.claude-plugin/plugin.json', 'README.md', 'LICENSE']) {
  if (!files.includes(need)) fail(`package is missing ${need}`);
}
for (const f of files) if (/^(test|scripts|\.github|node_modules)\//.test(f)) fail(`package should not ship ${f}`);
ok(`package: ${files.length} files, ${(pack.unpackedSize / 1024).toFixed(1)} kB unpacked`);

// 2. No runtime dependencies
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
if (Object.keys(pkg.dependencies || {}).length) fail('runtime dependencies are not allowed');
else ok('zero runtime dependencies');

// 3. Plugin manifests
const plugin = JSON.parse(fs.readFileSync('.claude-plugin/plugin.json', 'utf8'));
const market = JSON.parse(fs.readFileSync('.claude-plugin/marketplace.json', 'utf8'));
if (plugin.name !== 'ccretro') fail('plugin.json name must be ccretro');
if (plugin.version !== pkg.version) fail(`plugin.json version ${plugin.version} != package.json ${pkg.version}`);
if (!market.plugins?.some((p) => p.name === plugin.name && p.source)) fail('marketplace.json must list the plugin with a source');
for (const dir of fs.readdirSync('skills')) {
  const md = fs.readFileSync(path.join('skills', dir, 'SKILL.md'), 'utf8');
  const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) { fail(`skills/${dir}/SKILL.md has no frontmatter`); continue; }
  if (!new RegExp(`^name: ${dir}$`, 'm').test(fm[1])) fail(`skills/${dir}/SKILL.md name must be ${dir}`);
  if (!/^description: .{20,}/m.test(fm[1])) fail(`skills/${dir}/SKILL.md needs a description`);
}
ok('plugin manifests and skills');

// npm 12 refuses git specs unless --allow-git is set, so every documented
// `npx github:` invocation has to carry it.
for (const f of ['README.md', ...fs.readdirSync('skills').map((d) => path.join('skills', d, 'SKILL.md'))]) {
  for (const m of fs.readFileSync(f, 'utf8').matchAll(/npx [^\n`]*github:0-draft\/ccretro/g)) {
    if (!m[0].includes('--allow-git=root')) fail(`${f}: "${m[0]}" needs --allow-git=root for npm 12`);
  }
}
ok('npx instructions work on npm 12');

// 4. CLI starts, and fails cleanly with no data
const help = spawnSync(process.execPath, ['bin/ccretro.mjs', '--help'], { encoding: 'utf8' });
if (help.status !== 0 || !help.stdout.includes('Usage: ccretro')) fail('ccretro --help');
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ccretro-empty-'));
const env = { ...process.env, CLAUDE_CONFIG_DIR: empty, XDG_DATA_HOME: empty, XDG_CACHE_HOME: empty, XDG_CONFIG_HOME: empty };
const run = spawnSync(process.execPath, ['bin/ccretro.mjs', '--no-ai', '--no-open'], { encoding: 'utf8', env });
if (run.status !== 1 || !/no prompts found/.test(run.stderr)) fail(`empty history should exit 1 with a message, got ${run.status}: ${run.stderr}`);
const bad = spawnSync(process.execPath, ['bin/ccretro.mjs', '--days', 'x'], { encoding: 'utf8', env });
if (bad.status !== 2) fail('invalid --days should exit 2');
ok('CLI smoke');
