/* src/core/tactics-budget.ts — 战术层的**每档预算**（P1 冻结层）
 *
 * 背景（docs/plans/2026-10-03-tactics-fidelity-and-elo-ladder.md §3 D1/D3）：
 * 战术层的搜索上限过去散落在 `src/core/tactics.ts` 与 `src/core/engines/gomoku.ts` 的常量里
 * （`VCF_PLIES`、`VCT_NODE_LIMIT`、`PRESSURE_CUT_MAX`…）。**任何一次调参都会静默改写全部历史档位的
 * 行为** —— 于是「v11 到底看见什么」这个问题在代码变更后就再也答不出来了，回放/考古/复现全失去意义。
 *
 * 这里把 15 个上限集中成一份**可记录、可冻结**的预算表：每个战术版本在登记表里带一份 `budget`，
 * 调用时下传。`DEFAULT_BUDGET` 就是**冻结当天的常量逐字**，因此：
 *   ① P1 只做**零行为变更**（所有档位都写 `DEFAULT_BUDGET`，输出与冻结前逐字节一致）；
 *   ② 以后要调参，只能新增一档、写上新预算，老档位继续跑老数字；
 *   ③ P3 考古时，把某档的历史预算写成显式对象即可（`fidelity: 'restored'`）。
 *
 * 三条纪律：
 *   - **缺省 = 历史常量**：引擎侧 opts 缺省时的回落值必须与这里的默认值同源同名同数（见 gomoku.ts）。
 *   - **只减不增**：预算只允许收紧（AGENTS.md 规则 10「战术层不吃搜索」），要放开必须走新档 + 实验证据。
 *   - **加新上限时同步登记表**：任何影响某档决策的硬编码阈值都应搬到这里，否则冻结就是假的
 *     （`test/parity` 的 P2 指纹是这条的机械兜底）。
 */

/** 战术层一次推算里所有可调的搜索上限。字段名 = 语义（不写 `max`/`num` 之类的后缀）。 */
export interface EngineBudget {
  /** VCF 搜索深度（ply）。原 `tactics.ts` 的 `VCF_PLIES`。 */
  vcfPlies: number;
  /** VCF 节点上限。原 `gomoku.ts` 的 `vcfWin` 局部常量 `NODE_LIMIT`。 */
  vcfNodeLimit: number;
  /** VCF 每层最多展开几个逼迫着法。原 `gomoku.ts` 的 `forcingMoves().slice(0, 12)`。 */
  vcfMovesMax: number;
  /** VCT 搜索深度（ply）。原 `tactics.ts` 的 `VCT_PLIES`。 */
  vctPlies: number;
  /** VCT 节点上限。原 `gomoku.ts` 的 `VCT_NODE_LIMIT`。 */
  vctNodeLimit: number;
  /** VCT 每层最多展开几个攻击方着法。原 `gomoku.ts` 的 `VCT_MOVES_MAX`。 */
  vctMovesMax: number;
  /** VCT 活三逼迫时，守方应手多于这个数就不当作逼迫手。原 `VCT_DEFUSERS_MAX`。 */
  vctDefusersMax: number;
  /** v12 拆链搜索的候选点数上限。原 `gomoku.ts` 的 `VCT_DEF_MAX`。 */
  vctDefMax: number;
  /** v12 拆链凑够几个可用点就收工。原 `VCT_DEF_KEEP`。 */
  vctDefKeep: number;
  /** v12 拆链里复验「对手还有没有纯冲四链」用的深度。原 `VCF_DEF_PLIES`。 */
  vcfDefPlies: number;
  /** v12 并列拆法排序时，压力粗算的早退阈值。原 `vctDefense` 里的 `pressureOf(board, A, 3)`。 */
  vctDefPressureLimit: number;
  /** 破活三最多评估几个候选点。原 `gomoku.ts` 的 `LIVE3_DENY_EVAL_MAX`。 */
  live3DenyEvalMax: number;
  /** v13 削点搜索的候选点数上限。原 `PRESSURE_CUT_MAX`。 */
  pressureCutMax: number;
  /** v13 削点并列最优里最多留几个点。原 `PRESSURE_CUT_KEEP`。 */
  pressureCutKeep: number;
  /** 做四手数的默认早退阈值（`fourPressure` 不传 limit 时的 99 = 不早退）。 */
  fourPressureLimit: number;
}

/** 冻结当天的常量逐字（2026-10-03，commit `446f976`）。改这个对象 = 改所有历史档位的行为，不许。 */
export const DEFAULT_BUDGET: EngineBudget = Object.freeze({
  vcfPlies: 7,
  vcfNodeLimit: 4000,
  vcfMovesMax: 12,
  vctPlies: 9,
  vctNodeLimit: 3000,
  vctMovesMax: 10,
  vctDefusersMax: 6,
  vctDefMax: 12,
  vctDefKeep: 3,
  vcfDefPlies: 7,
  vctDefPressureLimit: 3,
  live3DenyEvalMax: 24,
  pressureCutMax: 120,
  pressureCutKeep: 3,
  fourPressureLimit: 99,
} satisfies EngineBudget);

/** 预算字段名（登记表自检与 P2 指纹用：少写一个字段就是冻结漏了一个口子）。 */
export const BUDGET_KEYS: readonly (keyof EngineBudget)[] = Object.freeze([
  'vcfPlies', 'vcfNodeLimit', 'vcfMovesMax',
  'vctPlies', 'vctNodeLimit', 'vctMovesMax', 'vctDefusersMax',
  'vctDefMax', 'vctDefKeep', 'vcfDefPlies', 'vctDefPressureLimit',
  'live3DenyEvalMax', 'pressureCutMax', 'pressureCutKeep', 'fourPressureLimit',
] as (keyof EngineBudget)[]);

/** 把（可能不完整的）预算补成完整预算：缺的字段一律回落 `DEFAULT_BUDGET`。
 *  非正数/非有限值的字段同样回落 —— 预算写错的后果只能是「少看见」，不能是「搜到天荒地老」。 */
export function budgetOf(partial?: Partial<EngineBudget> | null): EngineBudget {
  const out: EngineBudget = { ...DEFAULT_BUDGET };
  if (!partial) return out;
  for (const k of BUDGET_KEYS) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/** 两份预算是否逐字段相等（登记表自检 / 指纹测试的助手）。 */
export function sameBudget(a: Partial<EngineBudget> | null | undefined, b: Partial<EngineBudget> | null | undefined): boolean {
  const x = budgetOf(a), y = budgetOf(b);
  return BUDGET_KEYS.every((k) => x[k] === y[k]);
}
