/* record/export.ts — 棋谱归档 payload 的纯函数化
 * （迁移自 js/app.js:706-789 的 `buildGameExport` 与 709-742 的 `calSamples` / `exportSideCfg`）
 *
 * 为什么单独一个模块：旧 `buildGameExport()` 闭包读模块级 `S`，于是「棋谱长什么样」这件事
 * 只能靠跑整个页面来验证。纯函数化之后（计划 §6.3 点名的改造），拿 `games/**` 里的真实
 * 归档反推 session 就能逐字段比对。
 *
 * 与旧实现的关系：
 *  - 旧字段（format/exported/game/gid/mode/channel/slug/duel/blackChannel/whiteChannel/
 *    experiment/expGameNo/tacticsVersion/blackTactics/whiteTactics/result/endBy/notation/
 *    moves/meta/cal/firstWin/mock）**逐字保留**，拼法与默认值都不动；
 *  - **有意新增**（计划 §5.1 + `src/shared/record-map.ts` 的新客户端字段，全部可选）：
 *    `gameUid`（D1 去重键，旧客户端由服务端 sha1 合成）、`gameId`（引擎 id）、
 *    `winner`/`endReason`（结构化胜负，省掉服务端解析中文串）、每手 `ai.tac`
 *    （record-map.ts:397-399 明确按 `ai.tac` 取每手战术，旧实现只写了 `move.tactics`）。
 *    这几项都是**加字段不改旧字段**，旧消费方容忍缺省。
 *  - **2026-10-02 起的唯一值语义变化**：`tacticsVersion`/`blackTactics`/`whiteTactics` 只在
 *    「这一侧真的会跑战术层」的渠道上才写档位（`proxy` 系列），`rapfi`/`mock`/人类侧写空串
 *    （D1 里落 NULL）。键集合、拼法与默认值都没动，只是不再把配置里的惰性档位当成事实。
 *  - **2026-10-03 补的第二个只写「有意义的侧」字段**：`blackThink`/`whiteThink`（固定思考档
 *    毫秒）只在该侧渠道是 `rapfi` 且预算 > 0 时写（`thinkMsOf()`）。`proxy`/人类侧的思考时间
 *    不是配置出来的，写 0 会被报表读成「0 毫秒档」。旧归档没有这两个键，新客户端才写。
 */
import { aiGameMeta, aiMoveMeta, type AiGameMeta, type AiMoveMeta } from '../meta.ts';
import { effectiveChannelOf, effSide, type EffSide } from '../persist.ts';
import { aiMovesOf, isAISide, sideNameOf, type GameSession, type SessionMeta } from '../session.ts';
import { duelLabel, slug, tacticsLabel } from '../view/duel.ts';
import type { Engine, GameStatus } from '../types.ts';

/** 归档格式标识（旧实现硬编码，js/app.js:759）。 */
export const GAME_EXPORT_FORMAT = 'jev-qiguan-game/v1';

/** 模式中文名（js/app.js:763 与 1566 两处同表）。 */
export const MODE_LABELS: Record<string, string> = { 'human-ai': '人机', 'ai-ai': '机机', pvp: '双人' };

/** 单边槽位：旧实现的 `sideConfig` 与 `effSide()` 都按 `'black'`/`'white'` 两槽查，
 *  **不是引擎的 side id**（象棋是 r/b、跳棋是 bottom/top）。 */
export type SideSlot = 'black' | 'white';

/** 归档里的一手（旧 js/app.js:746-752）。 */
export interface GameRecordMove {
  ply: number;
  side: string;
  notation: string;
  /** 每手战术标记：旧实现写在 move 上（`m.tactics`），不是 `ai` 里 */
  tactics?: string;
  /** 归档短键（`ch/mdl/conf/p/rank/cands/ms/tv`）+ 新补的 `tac` */
  ai?: AiMoveMeta & { tac?: string | null };
}

/** 棋谱归档 payload。旧字段全部必填（旧实现总是写），新增字段只有能确定时才写。 */
export interface GameRecord {
  format: string;
  exported: string;
  game: string;
  gid: string;
  mode: string;
  channel: string;
  slug: string;
  duel: string;
  blackChannel: string;
  whiteChannel: string;
  experiment?: string;
  expGameNo?: number;
  tacticsVersion: string;
  blackTactics: string;
  whiteTactics: string;
  result: string;
  endBy?: string;
  notation: string;
  moves: GameRecordMove[];
  meta: AiGameMeta;
  cal: number[];
  firstWin: boolean | null;
  mock: boolean;
  /* ---- 以下为新增（可选）字段 ---- */
  /** 固定思考档（毫秒）：只有 `rapfi` 侧会写（见 `thinkMsOf()`），其余缺省 */
  blackThink?: number;
  whiteThink?: number;
  /** 对局身份：同一局重传恒定（D1 去重键来源） */
  gameUid?: string;
  /** 引擎 id（旧 `gid` 历史上装的是棋种 id，这里显式给一个语义明确的字段） */
  gameId?: string;
  /** 结构化胜方（D1 的 `winner` 列；中文结果串对红方/下方这些棋种解析不出来） */
  winner?: 'black' | 'white';
  /** 结构化终局原因（D1 的 `end_reason` 列） */
  endReason?: string;
}

/** 单边最终配置（旧 `exportSideCfg()`）：机机局就是 effSide，人类那一侧带 `human` 标记。
 *  显式列出三个字段（而不是展开 `EffSide`），保证归档 payload 的键集合与旧实现逐字一致。 */
export interface ExportSideCfg extends EffSide {
  human?: boolean;
  [k: string]: unknown;
}

function asSideCfg(cfg: EffSide, human?: boolean): ExportSideCfg {
  const out: ExportSideCfg = {
    channel: cfg.channel,
    tactics: cfg.tactics,
    rapfiThinkMs: cfg.rapfiThinkMs,
  };
  if (human) out.human = true;
  return out;
}

/** 固定思考档（`black_think`/`white_think` 两列）只在**吃固定思考预算**的渠道上写。
 *
 *  为什么加值域闸门：`proxy` 的思考时间是模型往返（不是配置出来的），人类侧根本没有预算，
 *  写 0 会被报表读成「0 毫秒档」这种不存在的身份（与 2026-10-02 的 `rapfi|v9-vcf-sound`
 *  幻影身份同一类事故）。所以只认 `channel === 'rapfi'` 且 `> 0` 的数值，其余留空（D1 落 NULL）。
 *  取值优先级：轮次快照（`expInfo.blackThink/whiteThink`，本局开跑时的配置）→ 侧配置
 *  （`sideConfig.*.rapfiThinkMs`，抽屉当前值）。 */
export function thinkMsOf(channel: string | null | undefined, ...candidates: unknown[]): number | undefined {
  if (channel !== 'rapfi') return undefined;
  for (const c of candidates) {
    const n = typeof c === 'number' ? c : typeof c === 'string' ? Number(c) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.round(n);
  }
  return undefined;
}

/** `buildGameExport()` / `exportSideCfg()` 的可选项。 */
export interface BuildExportOpts {
  /** `location.protocol === 'file:'`（旧实现的唯一 DOM 依赖，改注入） */
  isFile?: boolean;
  /** 覆写 `exported` 时间戳（单测要确定性；缺省 `new Date().toISOString()`） */
  exported?: string;
}

/** 校准样本（旧 `calSamples()`，js/app.js:709-730）：先手方视角的逐手胜率预测。
 *
 *  战绩簿与同步 payload 共用一份口径。离线演示的合成概率与 random 基线（noul 为 null）
 *  都不进样本——拿合成数据算校准等于自欺。`firstWin` 为 null（和棋/未终局）时由消费方剔除。
 *  `mock` 按「本局是否没有任何真实渠道着法」判定：对比实验里一方 mock 一方 Jev 时，
 *  Jev 那半局的样本仍然有效。
 */
export interface CalSamples {
  cal: number[];
  firstWin: boolean | null;
  mock: boolean;
}

export function calSamples(session: GameSession, engine: Engine, g: GameStatus): CalSamples {
  const items = aiMovesOf(session);
  const firstId = engine.sides[0] ? engine.sides[0].id : '';
  const cal = items
    .filter((h) => {
      const m = h.meta as SessionMeta;
      return !m.mock && typeof m.noul === 'number';
    })
    .map((h) => {
      const m = h.meta as SessionMeta;
      const noul = m.noul as number;
      const v = m.side === firstId ? noul : 1 - noul;
      return Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
    });
  const firstWin: boolean | null = g.winner ? g.winner === firstId : null;
  const mock = items.length > 0 && items.every((h) => !!(h.meta as SessionMeta).mock);
  return { cal, firstWin, mock };
}

/** 单边最终配置（旧 `exportSideCfg()`，js/app.js:738-742）。
 *
 *  人类那一侧必须打 `human` 标记：否则 `duel.sideLabel/sideSlug` 只看到「渠道配置」，
 *  人机局会被写成「双方都是 Jev」的镜像局，把按战术版本归因的输入弄脏。
 */
export function exportSideCfg(
  session: GameSession,
  engine: Engine,
  slot: SideSlot,
  opts?: BuildExportOpts | null,
): ExportSideCfg {
  const cfg = effSide(session.settings, slot, opts);
  const sides = engine.sides || [];
  const i = slot === 'black' ? 0 : 1;
  const side = sides[i] || sides[0];
  if (!side) return asSideCfg(cfg);
  return isAISide(session, side.id) ? asSideCfg(cfg) : asSideCfg(cfg, true);
}

/** 把终局原因拼成旧实现的中文结果串（js/app.js:775-777）。 */
export function formatResultText(session: GameSession, engine: Engine, g: GameStatus): string {
  if (!g.over) return '进行中（已 ' + session.history.length + ' 手）';
  const head = g.winner ? sideNameOf(engine, g.winner) + ' 获胜' : '和棋';
  return head + '（' + (g.reason || '') + '）';
}

/** 显示名 → D1 的胜负列（规则与 `src/shared/record-map.ts` 的 `parseResult()` 一致：
 *  只有「黑方 / 白方」能定；红方 / 下方（先手）这类返回 null，让服务端按原串留空）。 */
export function winnerSideOf(engine: Engine, winnerId: string | null | undefined): 'black' | 'white' | null {
  if (!winnerId) return null;
  const name = sideNameOf(engine, winnerId);
  if (name.indexOf('黑方') === 0) return 'black';
  if (name.indexOf('白方') === 0) return 'white';
  return null;
}

/** 棋谱导出 payload（旧 `buildGameExport()`，js/app.js:744-789）。 */
export function buildGameExport(session: GameSession, engine: Engine, opts?: BuildExportOpts | null): GameRecord {
  const g = engine.getStatus(session.st);
  const moves: GameRecordMove[] = session.history.map((h) => {
    const m: GameRecordMove = { ply: h.ply, side: sideNameOf(engine, h.side), notation: h.move.notation };
    const meta = h.meta as SessionMeta | null;
    if (meta && meta.tactics) m.tactics = meta.tactics;
    const ai: (AiMoveMeta & { tac?: string | null }) | null = h.ai ? { ...h.ai } : aiMoveMeta(h.move.notation, meta);
    if (ai) {
      if (meta && meta.tactics && !ai.tac) ai.tac = meta.tactics;
      m.ai = ai;
    }
    return m;
  });
  const exp = session.expInfo || null;
  const cs = calSamples(session, engine, g);
  const bCfg = exportSideCfg(session, engine, 'black', opts);
  const wCfg = exportSideCfg(session, engine, 'white', opts);
  const by = typeof g.by === 'string' ? g.by : null;
  /* 双方渠道先定下来：战术档标签要不要写，取决于**这一侧的渠道到底跑不跑战术层**
     （`rapfi`/`mock`/人类侧不跑，见 `view/duel.ts:runsTactics`）。 */
  const bChan = exp ? exp.blackChannel : bCfg.channel;
  const wChan = exp ? exp.whiteChannel : wCfg.channel;
  /* 固定思考档：`rapfi` 侧的预算必须落库，否则报告的「成本对照」只能回头翻轮次配置
     （2026-10-03 发现的缺口：AI-AI 轮的 black_think/white_think 长期为 NULL）。 */
  const bThink = thinkMsOf(bChan, exp ? exp.blackThink : undefined, bCfg.rapfiThinkMs);
  const wThink = thinkMsOf(wChan, exp ? exp.whiteThink : undefined, wCfg.rapfiThinkMs);
  const rec: GameRecord = {
    format: GAME_EXPORT_FORMAT,
    exported: (opts && opts.exported) || new Date().toISOString(),
    game: engine.name,
    gid: session.gameId,
    mode: MODE_LABELS[session.mode] || session.mode,
    channel: effectiveChannelOf(session.settings, session.settings.channel, opts),
    /* 联名三件套：文件名 slug / 展示联名 / 双方渠道与战术档（旧消费方都容许缺省） */
    slug: slug(bCfg, wCfg),
    duel: duelLabel(bCfg, wCfg),
    blackChannel: bChan,
    whiteChannel: wChan,
    experiment: exp ? exp.tag : undefined,
    expGameNo: exp ? exp.gameNo : undefined,
    /* 战术档标签只在会跑战术层的渠道上有意义：Rapfi/mock/人类侧写空串（归档里落 NULL）。
       2026-10-02 的事故：Rapfi 侧照抄了脚本默认档位，报表里于是出现 `rapfi|v9-vcf-sound` 幻影身份。 */
    tacticsVersion: tacticsLabel({ channel: bChan, tactics: bCfg.tactics }),
    blackTactics: tacticsLabel({ channel: bChan, tactics: exp ? exp.blackTactics : bCfg.tactics }),
    whiteTactics: tacticsLabel({ channel: wChan, tactics: exp ? exp.whiteTactics : wCfg.tactics }),
    result: formatResultText(session, engine, g),
    /* 终局裁决来源：'human' = 人手点「认输」；缺省 = 引擎自判（五连/禁手/棋盘满）。 */
    endBy: g.over && by ? by : undefined,
    notation: moves.map((m) => m.notation).join(','),
    moves,
    meta: aiGameMeta(session.history, { topK: session.settings.topK }),
    cal: cs.cal,
    firstWin: cs.firstWin,
    mock: cs.mock,
  };
  if (session.gameUid) rec.gameUid = session.gameUid;
  rec.gameId = session.gameId;
  if (bThink != null) rec.blackThink = bThink;
  if (wThink != null) rec.whiteThink = wThink;
  const ws = g.over ? winnerSideOf(engine, g.winner) : null;
  if (ws) rec.winner = ws;
  if (g.over && g.reason) rec.endReason = g.reason;
  return rec;
}
