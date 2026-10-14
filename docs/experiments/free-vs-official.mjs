/* free-vs-official.mjs — 统计检验：zen-o2a 的 jev-1.13-free 是否等价官方 jev-1.13.0
 *
 * 关键：官方基准当初是**三问**（move/edge/position，AGENTS 规则 8）发的。为免输入不一致污染对比，
 * 这里用引擎从存档 state 重建**完整三问**，保证 free 腿与重打官方拿到的 questions 与存档官方逐字相同。
 * 校验：重建的 move.instructions 的 SHA 必须 == 存档 instructionsSha，否则该行跳过并报数。
 *
 *  ① 漂移对照：抽 60 局面紧邻重打官方（同输入、同时段）→ 官方 vs 官方(新) 自一致 = 噪声地板
 *  ② 主对比：500 局面各打 free 腿 NPER 次，与存档官方比众数一致率 + 概率向量 TV
 * 边采边 append 落盘。用法：node .work/free-vs-official.mjs [NPER] [OUT_FREE] [OUT_REPLAY]
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getGame } from '../../src/core/registry.ts';
import { computeTactics, attachFacts, mechOf } from '../../src/core/tactics.ts';

const NPER = Number(process.argv[2] || 6);
const OUT_FREE = process.argv[3] || '.work/free-500x6.jsonl';
const OUT_REPLAY = process.argv[4] || '.work/official-replay-60x6.jsonl';
const BASE = 'docs/experiments/official-baseline-large-500x6.jsonl';
const DICT = 'docs/experiments/official-baseline-instructions.json';
const GATEWAY = 'http://172.18.0.4:8080/v1/systemone';
const OFFICIAL = 'https://api.typesafe.ai/v1/systemone';
const K_ROUTER = process.env.JEV_ROUTER_KEY || '', K_OFF = process.env.JEV_OFFICIAL_KEY || '';
if (!K_ROUTER || !K_OFF) { console.error('缺 key'); process.exit(2); }
const REAL = { v14: 'v14-live3-fresh', 'v14.1': 'v15-vctfirst', 'v14.2': 'v16-softgate' };
const e = getGame('gomoku');
const parse = (n) => { const m = /^([A-O])(\d+)$/.exec(n); return m ? { r: Number(m[2]) - 1, c: m[1].charCodeAt(0) - 65 } : null; };
const rebuildState = (s) => {
  const st = e.newGame();
  for (const x of s.black_stones || []) { const p = parse(x); if (p) st.board[p.r][p.c] = 1; }
  for (const x of s.white_stones || []) { const p = parse(x); if (p) st.board[p.r][p.c] = 2; }
  st.moveNum = s.move_number - 1; st.turn = s.you_play; st.last = null;
  const lm = /^(\w+) ([A-O]\d+)$/.exec(s.last_move || ''); if (lm) { const p = parse(lm[2]); if (p) st.last = { notation: lm[2], r: p.r, c: p.c, side: lm[1] }; }
  return st;
};
const fullQuestions = (r) => {
  const st = rebuildState(r.state);
  const real = REAL[r.label] || r.label;
  const ser = e.serializeForJev(st, r.side);
  attachFacts(ser, computeTactics(e, st, e.getLegalMoves(st), null, real), undefined, { mech: mechOf(real) });
  return ser.questions;
};
async function ask(url, key, model, questions, state) {
  try {
    const r0 = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'curl/8.5.0' }, body: JSON.stringify({ state, model, questions }) });
    if (!r0.ok) return { err: r0.status };
    const j = await r0.json(); const mv = j.answers && j.answers.move;
    if (!mv || !mv.choice) return { err: 'no-choice' };
    return { choice: mv.choice, conf: mv.confidence ?? null, probs: mv.probabilities || {}, model: j.model };
  } catch (er) { return { err: String(er.message || er) }; }
}
const modal = (arr) => { const c = {}; for (const x of arr) c[x] = (c[x] || 0) + 1; const v = Object.values(c); return v.length ? Math.max(...v) / v.length : 0; };

const rows = readFileSync(BASE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const dict = JSON.parse(readFileSync(DICT, 'utf8'));
writeFileSync(OUT_FREE, ''); writeFileSync(OUT_REPLAY, '');
let shaBad = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const questions = fullQuestions(r);
  const sha = createHash('sha256').update(questions.move.instructions).digest('hex').slice(0, 16);
  if (sha !== r.instructionsSha) { shaBad++; if (i < 60) { } else continue; }
  const officialChoices = r.calls.filter((c) => !c.err).map((c) => c.choice);
  const f = []; for (let k = 0; k < NPER; k++) f.push(await ask(GATEWAY + '?leg=zen-o2a&strict=1', K_ROUTER, 'jev-1.13-free', questions, r.state));
  appendFileSync(OUT_FREE, JSON.stringify({ id: r.id, label: r.label, game: r.game, ply: r.ply, side: r.side,
    officialMean: r.mean, officialChoices, freeCalls: f.map((c) => c.err ? c : { choice: c.choice, conf: c.conf, probs: c.probs, model: c.model }) }) + '\n');
  if (i < 60) {
    const rc = []; for (let k = 0; k < NPER; k++) rc.push(await ask(OFFICIAL, K_OFF, 'jev-1.13.0', questions, r.state));
    appendFileSync(OUT_REPLAY, JSON.stringify({ id: r.id, label: r.label, game: r.game, ply: r.ply, side: r.side,
      archivedChoices: officialChoices, replayCalls: rc.map((c) => c.err ? c : { choice: c.choice, conf: c.conf, probs: c.probs, model: c.model }) }) + '\n');
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${rows.length}${shaBad ? '  (SHA 不符 ' + shaBad + ')' : ''}`);
}
console.log('DONE free=' + OUT_FREE + ' replay=' + OUT_REPLAY + ' shaBad=' + shaBad);
