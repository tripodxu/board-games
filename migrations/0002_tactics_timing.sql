-- migrations/0002_tactics_timing.sql
-- 战术层耗时记账（2026-10-02）
--
-- 背景：`game_moves.ms` 是「战术层 + 上游调用」的**总耗时**（`src/core/jev/client.ts` 的
-- `t0` 在战术计算之前、`latencyMs` 在返回前结算）。上游一次调用约 1 秒，而战术层
-- （`computeTactics` 的 VCF/VCT/活三事实 + `pickSafestParry` 的 3-ply 安全排序）
-- 正常只有几毫秒到几十毫秒 —— 于是「这层保险到底贵不贵」在总耗时里根本看不出来。
-- 本轮（m07650）要求每轮 Jev+战术 的对照实验都报**战术层平均耗时**，所以单开一列记。
--
-- 三列都可空，且 NULL 有两种含义，统计时都应当落在样本外：
--   1. 历史棋谱（0002 之前归档的 54+ 局）没有这个数；
--   2. Rapfi / mock 渠道**刻意不过战术层**（保持「Rapfi vs Jev」变量纯净）——
--      这里记 NULL 而不是 0：记 0 会把 Jev vs Rapfi 这类混合对局的平均值拉低，
--      看着像战术层变快了。SQL 的 `AVG()` 本来就会跳过 NULL，于是
--      `AVG(tac_ms)` 自动只统计「真过了战术层的手」，而 `COUNT(tac_ms)` 与
--      `COUNT(*)` 一起看还能知道覆盖了多少手。
--
-- 口径与 `src/core/meta.ts` 的 `aiGameMeta().tacticsMs`（{avg,max,n}）逐字一致：
-- 只统计 `tacticsMs` 有值的手。
ALTER TABLE game_moves ADD COLUMN tac_ms INTEGER;

-- 每局汇总（同一口径），这样任意一轮的战术层平均耗时就是一句 SQL：
--   SELECT experiment_tag, AVG(tac_avg_ms), MAX(tac_max_ms), COUNT(*) FROM games
--   WHERE experiment_tag = ? GROUP BY experiment_tag;
ALTER TABLE games ADD COLUMN tac_avg_ms INTEGER;
ALTER TABLE games ADD COLUMN tac_max_ms INTEGER;
