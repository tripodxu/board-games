// scripts/check-docs.mjs — 文档卫生检查（零依赖）
// 1) docs/memory/MEMORY.md 首条日期必须 ≥ 第二条（新条目置顶）
// 2) 所有 markdown 相对链接可解析，且不指向被 .gitignore 忽略的产物
//    （教训：链到 backups/export.sql 这类本地产物时，本机绿、CI/新克隆红 —— 2026-10-01 run 36852326658 就是这么红的）
// 3) docs/status.md 的「最后更新」不超过 30 天
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let bad = 0;
const fail = (msg) => { bad++; console.log('✗ ' + msg); };
const ok = (msg) => console.log('✓ ' + msg);

/** 该路径是否被 .gitignore 忽略（无 git 或不在工作树里就当作「没忽略」） */
const gitIgnored = (() => {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: ROOT, stdio: 'ignore' });
  } catch {
    return () => false;
  }
  return (abs) => {
    const rel = relative(ROOT, abs).split(sep).join('/');
    try {
      execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: ROOT, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
})();

/* 1) memory 置顶 */
const mem = readFileSync(join(ROOT, 'docs/memory/MEMORY.md'), 'utf8').replace(/```[\s\S]*?```/g, '');
const dates = [...mem.matchAll(/^## (\d{4}-\d{2}-\d{2})/gm)].map((m) => m[1]);
if (dates.length < 2) fail('MEMORY.md 至少需要 2 条带日期条目');
else if (dates[0] < dates[1]) fail(`MEMORY.md 首条 ${dates[0]} 早于第二条 ${dates[1]}（新条目必须置顶）`);
else ok(`memory 置顶正确（${dates[0]} ≥ ${dates[1]}）`);

/* 2) 相对链接 */
const mdFiles = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e.startsWith('.')) continue;
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (e.endsWith('.md')) mdFiles.push(p);
  }
})(ROOT);
let links = 0;
for (const f of mdFiles) {
  // 代码栅栏与行内代码里的链接不是真链接（行内代码常用来写「已删除文件」的例子）
  const text = readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of text.matchAll(/\]\(([^)#]+?)(#[^)]*)?\)/g)) {
    const target = m[1].trim();
    if (/^(https?:|mailto:)/.test(target)) continue;
    links++;
    let decoded;
    try { decoded = decodeURIComponent(target); } catch (_) { decoded = target; }
    const abs = resolve(dirname(f), decoded);
    const from = f.slice(ROOT.length + 1);
    if (!existsSync(abs)) {
      fail(`${from} 死链: ${target}`);
    } else if (gitIgnored(abs)) {
      fail(`${from} 链接指向被 .gitignore 忽略的产物: ${target}（本机存在，但 CI 与新克隆里没有）`);
    }
  }
}
ok(`检查 ${mdFiles.length} 个 md / ${links} 个相对链接`);

/* 3) status 时效 */
const st = readFileSync(join(ROOT, 'docs/status.md'), 'utf8');
const upd = /最后更新：(\d{4}-\d{2}-\d{2})/.exec(st);
if (!upd) fail('docs/status.md 缺少「最后更新：YYYY-MM-DD」');
else {
  const days = (Date.now() - new Date(upd[1] + 'T00:00:00+08:00').getTime()) / 86400000;
  if (days > 30) fail(`docs/status.md 最后更新 ${upd[1]} 已 ${Math.floor(days)} 天`);
  else ok(`status 最后更新 ${upd[1]}（${Math.floor(days)} 天内）`);
}

console.log(bad ? `\n${bad} 项未通过` : '\n全部通过');
process.exit(bad ? 1 : 0);
