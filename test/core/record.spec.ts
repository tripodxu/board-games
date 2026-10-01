/**
 * `src/core/record/{export,book,sync}.ts` 的真实校验（W2 第四批任务 ②③）。
 *
 * 方法：拿 `games/**` 里的**真实归档**反推 session（按金样记法逐手回放真实引擎），
 * 再用新实现重新导出，逐字段与归档比对。这样测的不是「我写的函数调用了我写的函数」，
 * 而是「新导出契约与旧产出的磁盘文件一致」。
 *
 * 允许的差异只有两类，都在断言里显式列出：
 *   1. `meta.code`：归档写的是旧 `BG.codeVersion`（手工常量 0.8.0），新实现写构建期注入的
 *      `CODE_VERSION`（ADR-0012），故比对时把它替换成 `CODE_VERSION`；
 *   2. 有意新增字段：`gameId` / `gameUid` / `winner` / `endReason` 与每手 `ai.tac`
 *      （D1 导入需要，见 `src/shared/record-map.ts:397-399`）。
 *
 * 唯一被排除的归档是「人手认输」那一局：引擎不建模认输，回放自然复现不出
 * `（认输）`，与金样差分里 `recordedResultMatched=false` 是同一件事。排除清单被
 * 单独断言钉住，防止将来悄悄扩大。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getGame } from '../../src/core/registry.ts';
import { setSeed } from '../../src/core/rng.ts';
import { CODE_VERSION } from '../../src/shared/version.ts';
import { createSession, sideNameOf } from '../../src/core/session.ts';
import type { GameSession, SessionMeta, SessionMode, SessionMove } from '../../src/core/session.ts';
import { DEFAULT_SETTINGS } from '../../src/core/persist.ts';
import type { Settings, StorageLike } from '../../src/core/persist.ts';
import { MODE_LABELS, buildGameExport, calSamples } from '../../src/core/record/export.ts';
import type { GameRecord } from '../../src/core/record/export.ts';
import {
  RECORDS_KEEP,
  RECORDS_KEY,
  buildExperience,
  buildRecordEntry,
  ensureSessionId,
  loadRecords,
  saveRecords,
  upsertRecord,
} from '../../src/core/record/book.ts';
import type { RecordBookEntry } from '../../src/core/record/book.ts';
import {
  SYNC_KEY,
  createSyncQueue,
  postViaSaveGame,
  retryDelayMs,
  successText,
  syncKey,
} from '../../src/core/record/sync.ts';
import type { SyncHttpResponse } from '../../src/core/record/sync.ts';
import type { Engine } from '../../src/core/types.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/* ---------- 归档读取与 fixture 选择 ---------- */

interface RawMove {
  ply: number;
  side: string;
  notation: string;
  tactics?: string;
  ai?: {
    ch: string | null; mdl: string | null; conf: number | null; p: number | null;
    rank: number | null; cands: number | null; ms: number | null; tv: string | null;
  };
}

interface RawMeta {
  code: string | null;
  topK: number | null;
  seed: number | null;
  aiMoves: number;
  costUsd: number;
  tokens: number;
  latencyMs: { avg: number; max: number } | null;
  conf: number | null;
  tactics: Record<string, number>;
}

interface RawArchive {
  format: string;
  exported: string;
  game: string;
  gid: string;
  mode: string;
  channel: string;
  slug?: string;
  duel?: string;
  blackChannel?: string;
  whiteChannel?: string;
  tacticsVersion?: string;
  blackTactics?: string;
  whiteTactics?: string;
  experiment?: string;
  expGameNo?: number;
  result: string;
  endBy?: string;
  notation: string;
  moves: RawMove[];
  meta?: RawMeta;
  cal?: number[];
  firstWin?: boolean | null;
  mock?: boolean;
  [k: string]: unknown;
}

function walkJson(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkJson(p, out);
    else if (p.endsWith('.json')) out.push(p);
  }
  return out;
}

const archives = walkJson(join(ROOT, 'games')).sort().map((abs) => ({
  abs,
  rel: abs.slice(ROOT.length).split('\\').join('/'),
  raw: readFileSync(abs, 'utf8'),
  payload: JSON.parse(readFileSync(abs, 'utf8')) as RawArchive,
}));

/** 结构最全（有 meta/slug/duel/cal）、且是真实渠道对局的归档。 */
const full = archives.filter((a) => {
  const p = a.payload;
  const aiMoves = (p.moves || []).filter((m) => m.ai).length;
  return !!(p.meta && p.slug && p.duel && p.tacticsVersion && Array.isArray(p.cal))
    && p.mock === false && p.cal !== undefined && p.cal.length === aiMoves && aiMoves > 0;
});

/** 引擎不建模「认输」，回放复现不出这一局的结果串（与金样 `recordedResultMatched=false` 同一件事）。 */
const resignArchives = full.filter((a) => a.payload.result.indexOf('认输') >= 0);
const roundTrip = full.filter((a) => a.payload.result.indexOf('认输') < 0);

/* ---------- 反推 session：按归档记法逐手回放真实引擎 ---------- */

/** 归档里的 `mode` 是中文标签（旧 `MODE_LABELS` 的产物），反查回会话模式。
 *  注意 3 份归档标着「人机」而双方都是 Jev（对比实验路径把 `S.mode` 留在 human-ai）：
 *  这是归档自身的事实，反推时以归档为准，`humanSide` 保持 null——两侧仍按 AI 侧导出。 */
const MODE_BY_LABEL: Record<string, SessionMode> = {
  '人机': 'human-ai',
  '机机': 'ai-ai',
  '双人': 'pvp',
};

function replay(archive: RawArchive): { session: GameSession; engine: Engine; g: ReturnType<Engine['getStatus']> } {
  const engine = getGame(archive.gid);
  if (!engine) throw new Error('缺引擎: ' + archive.gid);
  /* 对比实验局：双方渠道/战术档在旧实现里被写进 `S.settings.sideConfig`（js/app.js:1178），
     slug/duel/tacticsVersion 都从这里派生；`expInfo` 只是同一份配置的另一次快照。
     blackThink/whiteThink 不进归档，导出也不读，这里给设置里的默认值。 */
  const isExp = typeof archive.experiment === 'string';
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    channel: archive.channel,
    topK: archive.meta ? (archive.meta.topK as number) : DEFAULT_SETTINGS.topK,
    tacticsVersion: archive.tacticsVersion || DEFAULT_SETTINGS.tacticsVersion,
    sideConfig: {
      black: {
        channel: isExp ? (archive.blackChannel as string) : '',
        tactics: isExp ? (archive.blackTactics as string) : '',
        rapfiThinkMs: 0,
      },
      white: {
        channel: isExp ? (archive.whiteChannel as string) : '',
        tactics: isExp ? (archive.whiteTactics as string) : '',
        rapfiThinkMs: 0,
      },
    },
  };
  const session = createSession({
    gameId: archive.gid,
    mode: MODE_BY_LABEL[archive.mode] || 'ai-ai',
    settings,
  });
  if (isExp) {
    session.expInfo = {
      tag: archive.experiment as string,
      gameNo: typeof archive.expGameNo === 'number' ? archive.expGameNo : 1,
      blackChannel: archive.blackChannel as string,
      whiteChannel: archive.whiteChannel as string,
      blackTactics: archive.blackTactics as string,
      whiteTactics: archive.whiteTactics as string,
      blackThink: settings.rapfiThinkMs,
      whiteThink: settings.rapfiThinkMs,
    };
  }
  const cal = archive.cal || [];
  const aiMoves = archive.moves.filter((m) => m.ai);
  const n = aiMoves.length;
  /* 逐手 costUsd / input_tokens 在归档里只留了汇总，这里按微美元与整数 token 均分，
     保证重新汇总时逐位还原（Math.round(x*1e6)/1e6 与整数求和都是精确的）。 */
  const micro = Math.round((archive.meta ? archive.meta.costUsd : 0) * 1e6);
  const perMicro = n ? Math.floor(micro / n) : 0;
  const remMicro = n ? micro - perMicro * n : 0;
  const tokens = archive.meta ? archive.meta.tokens : 0;
  const perTok = n ? Math.floor(tokens / n) : 0;
  const remTok = n ? tokens - perTok * n : 0;
  const firstId = engine.sides[0].id;

  let st: unknown = engine.newGame();
  let calIdx = 0;
  let aiIdx = 0;
  const notas = archive.notation.split(',');
  expect(notas.length).toBe(archive.moves.length);
  notas.forEach((nota, i) => {
    const raw = archive.moves[i];
    const side = (st as { turn: string }).turn;
    const mv = engine.moveFromNotation(st, nota);
    if (!mv) throw new Error('无法回放记法 ' + nota + ' @' + (i + 1));
    let meta: SessionMeta | null = null;
    if (raw.ai) {
      const k = aiIdx++;
      const calVal = calIdx < cal.length ? cal[calIdx++] : null;
      /* cal 是「先手方视角」的预测：非先手手要翻转回来才是 noul（旧 calSamples 的逆运算） */
      const noul = calVal === null ? undefined : (side === firstId ? calVal : 1 - calVal);
      const rank = raw.ai.rank === null ? 0 : raw.ai.rank;
      meta = {
        byAI: true,
        side,
        sideName: sideNameOf(engine, side),
        channel: raw.ai.ch || undefined,
        model: raw.ai.mdl,
        latencyMs: raw.ai.ms === null ? undefined : raw.ai.ms,
        confidence: raw.ai.conf,
        candidates: raw.ai.cands === null ? undefined : raw.ai.cands,
        tacticsVersion: raw.ai.tv,
        tactics: raw.tactics || undefined,
        mock: false,
        noul,
        /* 归档只留了 `rank`/`p` 两个短键，反推 top：rank>=1 时用占位项把本手顶到第 rank 位
           （`aiMoveMeta` 用 `findIndex` 定 rank = i+1、p 取命中的那一项）；
           rank 为 null 时 top 留空，p 改由 `meta.p` 兜底（旧 `aiMoveMeta` 的第二分支）。 */
        top: rank > 0 && raw.ai.p !== null
          ? [
              ...Array(rank - 1).fill(null).map((_, j) => ({ notation: '#' + (j + 1), p: 0 })),
              { notation: nota, p: raw.ai.p },
            ]
          : [],
        p: rank > 0 || raw.ai.p === null ? undefined : raw.ai.p,
        costUsd: (perMicro + (k < remMicro ? 1 : 0)) / 1e6,
        usage: { input_tokens: perTok + (k < remTok ? 1 : 0), output_tokens: 0 },
      };
    }
    const h: SessionMove = { ply: i + 1, side, move: mv, meta };
    session.history.push(h);
    st = engine.applyMove(st, mv);
  });
  session.st = st;
  return { session, engine, g: engine.getStatus(st) };
}

/* ---------- ① 真实归档 → session → 再导出：逐字段一致 ---------- */

describe('record/export：真实归档反推再导出（新旧契约逐字段一致）', () => {
  it('fixture 选择是确定的（结构最全的真实归档 ≥3 份，认输局恰 1 份）', () => {
    expect(full.length).toBeGreaterThanOrEqual(3);
    expect(resignArchives.map((a) => a.rel)).toEqual([
      'games/2026-09-30/jev-v9-vs-jev-v8-20260930153334.json',
    ]);
    /* 被排除的认输局不是「没选中」，而是明确列在这里 */
    expect(roundTrip.length).toBe(full.length - 1);
  });

  it('seed 置空时 meta.seed 为 null（与归档一致），否则归档里不会有 null', () => {
    setSeed(null);
    for (const a of full) expect(a.payload.meta?.seed).toBeNull();
  });

  for (const a of full.filter((x) => x.payload.result.indexOf('认输') < 0)) {
    it('回放再导出与归档一致：' + a.rel, () => {
      setSeed(null);
      const { session, engine } = replay(a.payload);
      const rec = JSON.parse(JSON.stringify(buildGameExport(session, engine, { exported: a.payload.exported }))) as GameRecord;

      /* 键集合：归档的键必须全部在（不能丢字段），多出来的只能是登记过的新增字段 */
      const extra = Object.keys(rec).filter((k) => !(k in a.payload));
      expect(extra.filter((k) => ['gameId', 'gameUid', 'winner', 'endReason'].indexOf(k) < 0)).toEqual([]);
      /* 归档的键必须全在（不能丢字段）：用数组比对，失败信息直接列出缺了哪个键 */
      expect(Object.keys(a.payload).filter((k) => !(k in rec))).toEqual([]);

      /* 逐条对标量字段 */
      expect(rec.format).toBe(a.payload.format);
      expect(rec.exported).toBe(a.payload.exported);
      expect(rec.game).toBe(a.payload.game);
      expect(rec.gid).toBe(a.payload.gid);
      expect(rec.mode).toBe(a.payload.mode);
      expect(rec.channel).toBe(a.payload.channel);
      expect(rec.slug).toBe(a.payload.slug);
      expect(rec.duel).toBe(a.payload.duel);
      expect(rec.blackChannel).toBe(a.payload.blackChannel);
      expect(rec.whiteChannel).toBe(a.payload.whiteChannel);
      expect(rec.tacticsVersion).toBe(a.payload.tacticsVersion);
      expect(rec.blackTactics).toBe(a.payload.blackTactics);
      expect(rec.whiteTactics).toBe(a.payload.whiteTactics);
      expect(rec.notation).toBe(a.payload.notation);
      expect(rec.result).toBe(a.payload.result);
      expect(rec.cal).toEqual(a.payload.cal);
      expect(rec.firstWin).toBe(a.payload.firstWin);
      expect(rec.mock).toBe(a.payload.mock);

      /* 逐手：ply / 显示方名 / 记法 / 战术 / ai 短键（+新增 tac） */
      const expectedMoves = a.payload.moves.map((m) => {
        const out: Record<string, unknown> = { ply: m.ply, side: m.side, notation: m.notation };
        if (m.tactics) out.tactics = m.tactics;
        if (m.ai) out.ai = m.tactics ? { ...m.ai, tac: m.tactics } : { ...m.ai };
        return out;
      });
      expect(rec.moves).toEqual(expectedMoves);

      /* 汇总：除 code 外逐位一致（token / cost / 时延 / 置信度 / 战术分布都要还原） */
      const expectedMeta = { ...(a.payload.meta as RawMeta), code: CODE_VERSION };
      expect(rec.meta).toEqual(expectedMeta);

      /* 新增字段的取值 */
      expect(rec.gameId).toBe(a.payload.gid);
      expect(rec.gameUid).toBeUndefined();
      const firstId = engine.sides[0].id;
      /* `winner` 是「黑/白槽位」口径，`firstWin` 是「先手方是否取胜」口径：互为镜像。
         gomoku 的先手方就是黑方，红方/下方那类棋种 winner 会被留空，故只在有 winner 时比。 */
      const mirror = firstId === 'black' ? (a.payload.firstWin ? 'black' : 'white') : (a.payload.firstWin ? 'white' : 'black');
      expect(rec.winner).toBe(a.payload.firstWin === null ? undefined : mirror);
      expect(typeof rec.endReason).toBe('string');
    });
  }

  it('认输局：结构字段仍逐字段一致，只有结果串/胜负复现不出（引擎不建模认输）', () => {
    setSeed(null);
    const a = resignArchives[0];
    const { session, engine, g } = replay(a.payload);
    const rec = JSON.parse(JSON.stringify(buildGameExport(session, engine, { exported: a.payload.exported }))) as GameRecord;
    expect(a.payload.result).toContain('认输');
    expect(rec.notation).toBe(a.payload.notation);
    expect(rec.moves).toEqual(a.payload.moves.map((m) => {
      const out: Record<string, unknown> = { ply: m.ply, side: m.side, notation: m.notation };
      if (m.tactics) out.tactics = m.tactics;
      if (m.ai) out.ai = m.tactics ? { ...m.ai, tac: m.tactics } : { ...m.ai };
      return out;
    }));
    expect(rec.cal).toEqual(a.payload.cal);
    expect(rec.meta).toEqual({ ...(a.payload.meta as RawMeta), code: CODE_VERSION });
    /* 复现不出「认输」：终局判定来自人手，不是引擎 */
    expect(rec.result).not.toBe(a.payload.result);
    expect(g.reason).not.toBe('认输');
  });

  it('未终局导出（旧实现在这里给「进行中（已 N 手）」），endBy/winner/endReason 缺省', () => {
    setSeed(null);
    const a = roundTrip[0];
    const { session, engine } = replay(a.payload);
    const half = Math.floor(session.history.length / 2);
    session.history = session.history.slice(0, half);
    const st2 = (() => {
      let st: unknown = engine.newGame();
      for (const h of session.history) st = engine.applyMove(st, h.move);
      return st;
    })();
    session.st = st2;
    const rec = JSON.parse(JSON.stringify(buildGameExport(session, engine))) as GameRecord;
    expect(rec.result).toBe('进行中（已 ' + half + ' 手）');
    expect(rec.endBy).toBeUndefined();
    expect(rec.winner).toBeUndefined();
    expect(rec.endReason).toBeUndefined();
    expect(rec.gameId).toBe(a.payload.gid);
  });

  it('calSamples：mock 局与 random 基线（noul 为 null）都不进样本，firstWin 看先手方', () => {
    setSeed(null);
    const a = roundTrip[0];
    const { session, engine, g } = replay(a.payload);
    const cs = calSamples(session, engine, g);
    expect(cs.cal).toEqual(a.payload.cal);
    expect(cs.mock).toBe(false);
    /* 全 mock 局：样本空、mock 为真 */
    for (const h of session.history) if (h.meta) h.meta.mock = true;
    expect(calSamples(session, engine, g)).toEqual({ cal: [], firstWin: (a.payload.firstWin as boolean), mock: true });
  });
});

/* ---------- ② 战绩簿 ---------- */

function memStorage(init?: Record<string, string>): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(init || {}));
  return {
    map,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('record/book：战绩簿（离线降级路径的唯一数据源）', () => {
  const entry = (id: string): RecordBookEntry => ({
    id, t: 1, game: '五子棋', gid: 'gomoku', slug: 's', duel: 'd', mock: false,
    mode: '机机', winner: '黑方', firstWin: true, reason: '五连', endBy: '', notas: ['H8'], moves: 1, aiMoves: 1, avgLat: 0, cost: 0, cal: [0.5],
  });

  it('键名与旧实现逐字兼容，读损坏内容回退空表', () => {
    expect(RECORDS_KEY).toBe('jev_qiguan_records_v1');
    expect(loadRecords(memStorage())).toEqual([]);
    expect(loadRecords(memStorage({ [RECORDS_KEY]: 'nope' }))).toEqual([]);
    expect(loadRecords(memStorage({ [RECORDS_KEY]: '{"a":1}' }))).toEqual([]);
  });

  it('saveRecords 只留最近 60 条；upsertRecord 按 id 覆盖而不是追加', () => {
    const store = memStorage();
    const many = Array.from({ length: RECORDS_KEEP + 5 }, (_, i) => entry('id-' + i));
    saveRecords(store, many);
    const back = loadRecords(store);
    expect(back.length).toBe(RECORDS_KEEP);
    expect(back[0].id).toBe('id-5');

    const two = upsertRecord(upsertRecord([], entry('a')), entry('a'));
    expect(two.length).toBe(1);
    const replaced = upsertRecord([entry('a')], { ...entry('a'), winner: '白方' });
    expect(replaced.length).toBe(1);
    expect(replaced[0].winner).toBe('白方');
  });

  it('ensureSessionId：一局只生成一次（终局→悔棋→再终局只留一条战绩）', () => {
    const s = createSession({ gameId: 'gomoku' });
    const first = ensureSessionId(s, 1000);
    expect(s.sessionRecorded).toBe(true);
    expect(s.sessionId).toBe(first);
    expect(ensureSessionId(s, 2000)).toBe(first);
  });

  it('buildRecordEntry：字段与归档口径一致（slug/duel/mode/notas/aiMoves/avgLat/cal）', () => {
    setSeed(null);
    const a = roundTrip[0];
    const { session, engine, g } = replay(a.payload);
    const rec = buildRecordEntry(session, engine, g, { id: 'fixed-id', t: 42 });
    expect(rec.id).toBe('fixed-id');
    expect(rec.t).toBe(42);
    expect(rec.game).toBe(engine.name);
    expect(rec.gid).toBe(a.payload.gid);
    expect(rec.slug).toBe(a.payload.slug);
    expect(rec.duel).toBe(a.payload.duel);
    expect(rec.mode).toBe(a.payload.mode);
    expect(rec.mock).toBe(false);
    expect(rec.notas).toEqual(a.payload.notation.split(','));
    expect(rec.moves).toBe(session.history.length);
    expect(rec.aiMoves).toBe(a.payload.moves.filter((m) => m.ai).length);
    const ms = a.payload.moves.map((m) => (m.ai ? m.ai.ms : null)).filter((x): x is number => typeof x === 'number');
    expect(rec.avgLat).toBe(ms.length ? Math.round(ms.reduce((s, x) => s + x, 0) / ms.length) : 0);
    expect(rec.cost).toBeCloseTo(a.payload.meta ? a.payload.meta.costUsd : 0, 9);
    expect(rec.cal).toEqual(a.payload.cal);
    expect(rec.winner).toBe(g.winner ? sideNameOf(engine, g.winner) : (g.reason === '换边中断' ? '未终局' : '和棋'));
    expect(rec.reason).toBe(g.reason || '');
    expect(rec.endBy).toBe('');
  });

  it('buildExperience：同一开局前缀 ≥2 局才给，演示局与不同棋种不计', () => {
    const history = [{ move: { notation: 'H8' } }, { move: { notation: 'I9' } }];
    const r = (over: Partial<RecordBookEntry>): RecordBookEntry => ({ ...entry('x'), gid: 'gomoku', mock: false, notas: ['H8', 'I9', 'J10'], ...over });
    expect(buildExperience('gomoku', [], [r({})])).toBeNull();                       /* 空 history */
    expect(buildExperience('gomoku', history, [r({})])).toBeNull();                  /* 只有 1 局 */
    expect(buildExperience('gomoku', history, [r({}), r({ mock: true })])).toBeNull();/* 演示局不计 */
    expect(buildExperience('gomoku', history, [r({}), r({ gid: 'go' })])).toBeNull(); /* 不同棋种不计 */
    const exp = buildExperience('gomoku', history, [r({ firstWin: true }), r({ firstWin: false }), r({ notas: ['H8'] })]);
    expect(exp).toEqual({ opening_plies: 2, games: 2, first_player_win_rate: 0.5 });
  });
});

/* ---------- ③ 自动同步队列 ---------- */

describe('record/sync：自动同步（注入式队列 / 去重 / 退避重试）', () => {
  function sampleRecord(): GameRecord {
    setSeed(null);
    const a = roundTrip[0];
    const { session, engine } = replay(a.payload);
    return JSON.parse(JSON.stringify(buildGameExport(session, engine, { exported: a.payload.exported }))) as GameRecord;
  }

  const okRes = (path?: string, dedup?: boolean): SyncHttpResponse => (path ? { ok: true, id: '1', path } : { ok: true, id: '1', dedup });

  it('成功：文案与旧实现一致（有 path 带文件名），并记住去重键', async () => {
    const store = memStorage();
    const rec = sampleRecord();
    const post = async () => okRes('games/2026-09-30/x.json');
    const q = createSyncQueue({ post, storage: store, now: () => 1000 });
    const res = await q.sync(rec);
    expect(res.ok).toBe(true);
    expect(res.text).toBe('成功 · x.json');
    expect(q.state()).toEqual({ ok: true, text: '成功 · x.json' });
    expect(q.sent()).toEqual([syncKey(rec)]);
    expect(q.pending()).toEqual([]);
    expect(store.map.has(SYNC_KEY)).toBe(true);
    /* 同一局同一棋谱：本地去重，不再发第二次 */
    let calls = 0;
    const q2 = createSyncQueue({ post: async () => { calls++; return okRes(); }, storage: store, now: () => 2000 });
    const again = await q2.sync(rec);
    expect(calls).toBe(0);
    expect(again.skipped).toBe(true);
    expect(again.dedup).toBe(true);
    expect(again.text).toBe('成功 · 已同步过');
    /* 棋谱变了（悔棋后重下）→ 键变了 → 重新上传 */
    const changed = { ...rec, notation: rec.notation + ',A1' };
    const res3 = await q2.sync(changed);
    expect(calls).toBe(1);
    expect(res3.ok).toBe(true);
    expect(res3.text).toBe('成功');
  });

  it('HTTP 失败：文案带状态码，条目入队等退避重试', async () => {
    const store = memStorage();
    let t = 0;
    const rec = sampleRecord();
    let mode = 'fail';
    const q = createSyncQueue({
      post: async () => (mode === 'fail' ? { ok: false, status: 500 } : { ok: true }),
      storage: store,
      now: () => t,
    });
    const res = await q.sync(rec);
    expect(res.ok).toBe(false);
    expect(res.text).toBe('失败（HTTP 500）');
    expect(q.pending().length).toBe(1);
    expect(q.pending()[0].attempts).toBe(1);
    expect(q.pending()[0].lastStatus).toBe(500);
    /* 还没到退避时间：flush 不动 */
    t = retryDelayMs(1) - 1;
    expect(await q.flush()).toEqual([]);
    /* 到点：重试成功，队列清空 */
    t = retryDelayMs(1);
    mode = 'ok';
    const flushed = await q.flush();
    expect(flushed.length).toBe(1);
    expect(flushed[0].ok).toBe(true);
    expect(q.pending()).toEqual([]);
    expect(q.sent()).toEqual([syncKey(rec)]);
  });

  it('重试达上限后丢弃，不无限堆积（默认 3 次）', async () => {
    const store = memStorage();
    let t = 0;
    const q = createSyncQueue({ post: async () => ({ ok: false, status: 502 }), storage: store, now: () => t });
    const rec = sampleRecord();
    expect((await q.sync(rec)).attempts).toBe(1);
    t += 100000; expect((await q.flush())[0].attempts).toBe(2);
    t += 100000; expect((await q.flush())[0].attempts).toBe(3);
    expect(q.pending()).toEqual([]);          /* 第 3 次失败后丢弃 */
    t += 100000; expect(await q.flush()).toEqual([]);
  });

  it('网络异常（post 抛错）文案与旧 catch 一致；无后端时全部静默', async () => {
    const q = createSyncQueue({ post: async () => { throw new Error('offline'); }, storage: memStorage(), now: () => 0 });
    const res = await q.sync(sampleRecord());
    expect(res.ok).toBe(false);
    expect(res.text).toBe('失败（无后端或网络异常）');
    /* api client 的降级路径：saveGame 失败返回 null → 视同网络异常（拿不到状态码） */
    const q2 = createSyncQueue({ post: postViaSaveGame(async () => null), now: () => 0 });
    expect((await q2.sync(sampleRecord())).text).toBe('失败（无后端或网络异常）');
    const q3 = createSyncQueue({ post: postViaSaveGame(async () => ({ ok: true, path: 'games/a/b.json' })), now: () => 0 });
    expect((await q3.sync(sampleRecord())).text).toBe('成功 · b.json');
  });

  it('关闭自动同步 / 空棋谱：不发请求，也不算失败', async () => {
    let calls = 0;
    const post = async (): Promise<SyncHttpResponse> => { calls++; return { ok: true }; };
    const off = createSyncQueue({ post, storage: memStorage(), now: () => 0, enabled: () => false });
    const r1 = await off.sync(sampleRecord());
    expect(r1.skipped).toBe(true);
    expect(r1.ok).toBe(false);
    expect(off.state()).toBeNull();            /* 旧实现此时连 lastSync 都不动 */
    const empty = { ...sampleRecord(), notation: '' };
    expect((await off.sync(empty)).skipped).toBe(true);
    expect(calls).toBe(0);
  });

  it('reset 清空账本与队列；successText 只取路径末段', () => {
    expect(successText({ ok: true, path: 'games/2026-09-30/x.json' })).toBe('成功 · x.json');
    expect(successText({ ok: true })).toBe('成功');
    expect(successText(null)).toBe('成功');
    const store = memStorage();
    const q = createSyncQueue({ post: async () => ({ ok: false, status: 500 }), storage: store, now: () => 0 });
    return q.sync(sampleRecord()).then(() => {
      expect(q.pending().length).toBe(1);
      q.reset();
      expect(q.pending()).toEqual([]);
      expect(q.sent()).toEqual([]);
      expect(q.state()).toBeNull();
    });
  });

  it('积压条目在下次 sync 时优先补发（旧实现没有这一层）', async () => {
    let t = 0;
    const store = memStorage();
    let ok = false;
    const seen: string[] = [];
    const q = createSyncQueue({
      post: async (r) => { seen.push(r.notation); return ok ? { ok: true } : { ok: false, status: 503 }; },
      storage: store,
      now: () => t,
    });
    const recA = sampleRecord();
    await q.sync(recA);
    expect(q.pending().length).toBe(1);
    t += 100000;
    ok = true;
    const recB = { ...recA, notation: recA.notation + ',A1' };
    const res = await q.sync(recB);
    expect(res.ok).toBe(true);
    expect(seen.length).toBe(3);              /* 失败 + 补发 A + 上传 B */
    expect(q.pending()).toEqual([]);
    expect(q.sent().length).toBe(2);
  });
});
