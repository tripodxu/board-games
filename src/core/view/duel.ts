/* view/duel.ts — 对局/实验的命名与代号（迁移自 js/duel.js）
 *
 * 用途：图谱文件名、实验标签、分享文案。**纯字符串函数、零依赖**，
 * 因此 Node 下可直接回归；同时是「注入防御」的第一道闸（代号会被写进路径）。
 */
import { assert } from '../assert.ts';
import { resolve, tryResolve } from '../tactics-versions.ts';
import type { SideConfig } from '../persist.ts';

/* 单边配置**只有一份定义**（`persist.ts` 的 `SideConfig`）：设置抽屉、对比实验、驾驶舱
   与导出都往这里汇。duel 只读 channel / tactics / rapfiThinkMs，外加导出时给人类侧
   打的 `human` 标记（旧 `exportSideCfg`），故这里只派生一个输入形态，不再复制定义。 */
export type { SideConfig };

/** 命名函数的入参：设置里的单边配置、`effSide()` 的产物（`EffSide`）、UI 拼的半成品都收。
 *  字段全可选（调用方常常只给 channel），所以这里用 `Partial` 派生；
 *  **不能再加 `[k: string]: unknown` 索引签名**——那会让 `EffSide` 这类 interface 反而
 *  因为「缺索引签名」而不可赋值（TypeScript 只给对象字面量类型隐式补索引签名）。 */
export type SideInput = Partial<SideConfig> & { human?: boolean };

export const CH_SHORT: Record<string, string> = {
  proxy: 'Jev', openrouter: 'Jev', official: 'Jev', mock: '演示', rapfi: 'Rapfi', random: '随机',
};
export const CH_EN: Record<string, string> = {
  proxy: 'jev', openrouter: 'jev', official: 'jev', mock: 'mock', rapfi: 'rapfi', random: 'ran',
};

/** 战术档 id → 短版本号（v3-make2 → v3）。
 *
 *  P0/D2 起 `resolve()` 对未知档号抛错，而这里是**展示**路径（棋谱名、分享文案、
 *  归档里登记表外的历史值）⇒ 用 `tryResolve()`：认得出就归一到登记表 id，
 *  认不出就照抄原字符串（不许冒充当前档）。空值仍按老口径走当前档（「没指定」= 跟随默认）。
 */
export function versionTag(id?: string): string {
  const raw = String(id ?? '').trim();
  const v = raw ? tryResolve(raw) : resolve('');
  const src = v ? v.id : raw;
  const m = /^v\d+/.exec(src);
  if (m) return m[0]!;
  return v ? v.id : (raw || '未知');
}

/** 展示名：'我' / '演示' / 'Jev·v10' / '随机·v4' / 'Rapfi(3s)'（代理侧的短号跟登记表当前档走）。 */
export function sideLabel(cfg: SideInput | null | undefined): string {
  const c: SideInput = cfg || {};
  if (c.human) return '我';
  const ch = c.channel || 'mock';
  if (ch === 'rapfi') return 'Rapfi(' + Math.round((c.rapfiThinkMs || 3000) / 100) / 10 + 's)';
  if (ch === 'mock') return '演示';
  if (ch === 'random') return '随机·' + versionTag(c.tactics);
  return (CH_SHORT[ch] || ch) + '·' + versionTag(c.tactics);
}

/** 文件名/URL 代号片段（保守：只留 [a-z0-9-]）。 */
export function sideSlug(cfg: SideInput | null | undefined): string {
  const c: SideInput = cfg || {};
  if (c.human) return 'me';
  const ch = c.channel || 'mock';
  const en = CH_EN[ch] || String(ch).toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (ch === 'mock') return en;
  if (ch === 'rapfi') return 'rapfi-' + Math.round((c.rapfiThinkMs || 3000) / 100) / 10 + 's';
  return en + '-' + versionTag(c.tactics);
}

/** 该渠道这一侧会不会真的跑战术层：`mock` 与 `rapfi` 在 `client.ts` 里**直接短路**
 *  （连 `computeTactics` 都不进，所以那两侧的 `tac_ms` 恒为 NULL），人类那侧没有战术层。
 *  这三类侧写了战术档标签就是幻影身份——归档里会冒出 `rapfi|v9-vcf-sound` 这种并不存在的组合。 */
export function runsTactics(cfg: SideInput | null | undefined): boolean {
  const c: SideInput = cfg || {};
  if (c.human) return false;
  const ch = c.channel || '';
  return ch !== 'mock' && ch !== 'rapfi';
}

/** 归档/报表里的战术档标签：不过战术层的一侧写空串（`strOrNull('')` ⇒ D1 里落 NULL）。
 *  **只在会跑战术层的渠道上有意义**；`sideLabel()`/`sideSlug()` 早就按这个规则忽略 rapfi/mock 的档位，
 *  这里把同一条规则补到「原始字段」上，免得报表按 `渠道|战术|思考` 分组时造出幻影身份。 */
export function tacticsLabel(cfg: SideInput | null | undefined): string {
  const c: SideInput = cfg || {};
  return runsTactics(c) ? (c.tactics || '') : '';
}

export function duelLabel(black: SideInput, white: SideInput): string {
  return '黑 ' + sideLabel(black) + ' vs 白 ' + sideLabel(white);
}

export function gameLabel(gameName: string, mode: string, black: SideInput, white: SideInput): string {
  const m = mode === 'ai-ai' ? '机机' : mode === 'pvp' ? '双人' : '人机';
  return gameName + ' · ' + m + ' · ' + duelLabel(black, white);
}

export function expLabel(black: SideInput, white: SideInput, games?: number): string {
  return sideLabel(black) + ' vs ' + sideLabel(white) + ' ×' + (games || 4) + '局';
}

/** 对局标识：用于归档文件名与实验 tag，**必须是文件系统安全字符**。 */
export function slug(black: SideInput, white: SideInput): string {
  const s = (sideSlug(black) + '-vs-' + sideSlug(white))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'nogid').slice(0, 24);
}

export function selfTest(): void {
  const U = (c: unknown, m: string): void => { assert(c, m); };
  /* 代理侧展示名跟着登记表当前档走（v10 起不再写死短号：档位一升，这里只断言
     「标签与登记表一致」这条不变量，避免每次加版本都要来改一行字面量）。 */
  const CUR = versionTag();
  const V = 'Jev·' + CUR;
  U(/^v\d+$/.test(CUR), '当前档短号应形如 vN，实际 ' + CUR);
  U(sideLabel({ human: true }) === '我', 'human 展示名应为 我');
  U(sideLabel({ channel: 'mock' }) === '演示', 'mock 展示名应为 演示');
  U(sideLabel({ channel: 'proxy' }) === V, 'proxy 展示名应为 ' + V);
  U(sideLabel({ channel: 'random', tactics: 'v4-parry3' }) === '随机·v4', 'random 展示名应带版本号');
  U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 3000 }) === 'Rapfi(3s)', 'rapfi 3s 展示名不对');
  U(sideLabel({ channel: 'rapfi', rapfiThinkMs: 500 }) === 'Rapfi(0.5s)', 'rapfi 0.5s 展示名不对');
  U(duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }) === '黑 ' + V + ' vs 白 Rapfi(5s)',
    'duelLabel 不对：' + duelLabel({ channel: 'proxy' }, { channel: 'rapfi', rapfiThinkMs: 5000 }));
  U(gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }) === '五子棋 · 人机 · 黑 我 vs 白 ' + V,
    'gameLabel 不对：' + gameLabel('五子棋', 'human', { human: true }, { channel: 'proxy' }));
  U(expLabel({ channel: 'proxy' }, { channel: 'random', tactics: 'v3-make2' }, 4) === V + ' vs 随机·v3 ×4局',
    'expLabel 不对');
  U(slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' }) === 'ran-v3-vs-jev-' + CUR,
    'slug 不对：' + slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' }));
  const s2 = slug({ channel: 'random', tactics: 'v3-make2' }, { channel: 'proxy' });
  U(/^[a-z0-9_-]+$/.test(s2) && s2.length <= 24, 'slug 字符集/长度不对：' + s2);
  const evil = slug({ channel: 'random', tactics: '../../etc/pa' }, { channel: 'proxy' });
  U(evil.indexOf('/') < 0 && evil.indexOf('.') < 0, 'slug 必须滤掉路径字符，实际 ' + evil);
  U(!!slug({}, {}), '空配置也应给出非空代号');
  U(slug({ human: true }, { channel: 'proxy', tactics: 'v0-off' }) === 'me-vs-jev-v0', 'human slug 不对');
  U(duelLabel({ human: true }, { channel: 'proxy' }) === '黑 我 vs 白 ' + V, 'human duelLabel 不对');
  U(slug({ human: true }, { human: true }) === 'me-vs-me', '双人 slug 应为 me-vs-me');
  /* 战术档标签只在会跑战术层的渠道上有意义（2026-10-02 的 `rapfi|v9-vcf-sound` 幻影身份事故） */
  U(tacticsLabel({ channel: 'proxy', tactics: 'v11-vct' }) === 'v11-vct', 'proxy 侧战术标签应原样保留');
  U(tacticsLabel({ channel: 'rapfi', tactics: 'v9-vcf-sound', rapfiThinkMs: 500 }) === '', 'rapfi 侧不得写战术标签');
  U(tacticsLabel({ channel: 'mock', tactics: 'v11-vct' }) === '', 'mock 侧不得写战术标签');
  U(tacticsLabel({ human: true, tactics: 'v11-vct' }) === '', '人类侧不得写战术标签');
  U(tacticsLabel({ channel: 'proxy' }) === '', 'proxy 侧没配档位时给空串（不是 undefined）');
  U(runsTactics({ channel: 'random', tactics: 'v4-parry3' }), 'random 侧会跑战术层（client.ts:489 起用档位）');
}

export const duel = { CH_SHORT, CH_EN, versionTag, sideLabel, sideSlug, runsTactics, tacticsLabel, duelLabel, gameLabel, expLabel, slug, selfTest };
