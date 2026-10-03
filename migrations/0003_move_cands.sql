-- migrations/0003_move_cands.sql
-- 候选点数记账（2026-10-03，m13627）
--
-- 背景：`game_moves.cands`（0001 就有）记的是「**模型给了概率且落在我方合法着法里**的
-- 候选点数」——回答的是「模型评了几个点」。用户要的是另一个问题：「**经战术层之后，
-- 交给 Jev 决定的候选点有几个**」。两者数量级可以差很多（模型可以对 40 个点只给 8 个
-- 概率），合成一个数就再也拆不开，所以分列记，`cands` 的历史口径不动。
--
--   cands_sent    = 发给 Jev 的候选点数（= `questions.move.criteria` 的键数 = 请求里
--                   `options` 的长度，引擎上限 64：`src/core/engines/gomoku.ts` 的
--                   `candidates(st, 64)`）；
--   cands_labeled = 其中 `labelPoint` 非空的点数（即战术层给过标签的那些）。
--
-- 两列都可空，NULL 有两种含义，统计时都落在样本外：
--   1. 历史棋谱（0003 之前归档的局）没有这两个数；
--   2. Rapfi / mock / 人类侧**根本不过 Jev 候选集**——记 NULL 而不是 0：
--      0 是「交了 0 个候选点」这个不存在的状态，用它冒充缺失会把均值拉低。
-- 写库纪律与 `tac_ms` 同款（`src/core/meta.ts` 的 `aiMoveMeta()`：只在是 number 时写出）。
ALTER TABLE game_moves ADD COLUMN cands_sent INTEGER;
ALTER TABLE game_moves ADD COLUMN cands_labeled INTEGER;

-- 任意一轮的三个数就是一句 SQL（均值跳过 NULL，覆盖手数看 COUNT）：
--   SELECT experiment_tag,
--          AVG(cands) AS graded, AVG(cands_sent) AS sent, AVG(cands_labeled) AS labeled,
--          COUNT(cands_sent) AS n_sent, COUNT(*) AS n
--   FROM game_moves mv JOIN games g ON g.id = mv.game_id
--   WHERE g.experiment_tag = ? GROUP BY g.experiment_tag;
