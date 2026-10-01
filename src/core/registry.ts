/* registry.ts — 引擎注册表（迁移自 js/board.js 的 `BG.register` + `BG.games`）
 *
 * 旧实现：每个引擎文件尾部调用 `BG.register(def)`，把引擎按 `def.id` 存进 `BG.games`。
 * 新实现：改为具名导出 + 这一张显式注册表；语义等价（同 id、同顺序、同对象）。
 * `BG.games` 的键顺序即注册顺序：gomoku, gomoku-pro, go, xiangqi, chess, checkers, cc。
 */
import { createGomoku } from './engines/gomoku.ts';
import { go } from './engines/go.ts';
import { xiangqi } from './engines/xiangqi.ts';
import { chess } from './engines/chess.ts';
import { checkers } from './engines/checkers.ts';
import { chineseCheckers } from './engines/chinese-checkers.ts';
import type { Engine } from './types.ts';

/** 五子棋（大众模式，无禁手）。 */
export const gomoku: Engine = createGomoku('gomoku', '五子棋', false);
/** 五子棋·禁手（连珠规则职业模式）。 */
export const gomokuPro: Engine = createGomoku('gomoku-pro', '五子棋·禁手', true);

/** 单个引擎定义（`BG.games[id]` 的值）。 */
export interface GameDef {
  id: string;
  name: string;
  sides: { id: string; name: string; first?: boolean }[];
  meta?: { w: number; h: number };
  supportsPass?: boolean;
  supportsResign?: boolean;
  deepTactics?: boolean;
  [key: string]: unknown;
}

/** 全部引擎，键为引擎 id（对应旧 `BG.games`）。 */
export const games: Record<string, Engine> = {
  'gomoku': gomoku,
  'gomoku-pro': gomokuPro,
  'go': go,
  'xiangqi': xiangqi,
  'chess': chess,
  'checkers': checkers,
  'cc': chineseCheckers,
};

/** 全部引擎 id（注册顺序）。 */
export const ids: string[] = Object.keys(games);

/** 取引擎定义；未注册返回 undefined（对应旧 `BG.games[id]`）。 */
export function getGame(id: string): Engine | undefined {
  return games[id];
}

/** 注册引擎（对应旧 `BG.register`）。 */
export function register(def: GameDef): void {
  games[def.id] = def as unknown as Engine;
}
