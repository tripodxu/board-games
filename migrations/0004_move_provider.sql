-- 0004：逐手记录「这一手是谁答的」（C3 / C2 上游兜底提供方归因）。
--
-- provider：profile id，见 `src/core/jev/providers.ts` 的 `PROVIDERS`
--   `primary`  = TypeSafe 官方（默认主家）
--   `backup`   = commandcode 兜底
--   `custom`   = 浏览器直连的自定义端点（不参与切换）
--   `random`   = random 渠道（本地随机，没走模型）
--   `proxy`    = 经业主 Worker 转发（Worker 侧已按同一套判据切换过）
-- prob_source：这一手的逐点概率从哪来（C2/D-B3）
--   `exact`    = 模型真给了 `answers.move.probabilities`（或旧格式的 top[].p）
--   `derived`  = 没给逐点概率，概率是按候选等权/排序推的 —— 不能冒充模型概率进主口径
--
-- 与 `0002/0003` 同纪律：Rapfi / mock / 人类侧不过 Jev，记 NULL（不是空串、不是 0）；
-- 0004 之前的老归档也一律 NULL —— 缺失表示「当时还没这个口径」，不表示 primary/exact。
ALTER TABLE game_moves ADD COLUMN provider TEXT;
ALTER TABLE game_moves ADD COLUMN prob_source TEXT;
