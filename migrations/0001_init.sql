-- migrations/0001_init.sql
-- D1 初始 schema（ADR-0011）。设计依据与容量护栏见 docs/plans/2026-10-01-workers-d1-rebuild.md §4。
--
-- 约定：
--  * 本文件一旦应用到 remote 就不得修改，只能追加 0002_xxx.sql；
--  * `payload` 是保真副本，列化字段是派生值——两者不一致时以 payload 为准；
--  * 单行 payload 上限 512 KB（应用层校验，实测历史最大 68.7 KB）。

PRAGMA foreign_keys = ON;

-- ── 设备：匿名归属与「只看我的」（ADR-0013）────────────────────────────────
CREATE TABLE devices (
  device_id  TEXT PRIMARY KEY,
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL,
  label      TEXT,
  ua         TEXT
);

-- ── 对局主表：可查询字段列化 + 完整原始记录留 payload ───────────────────────
CREATE TABLE games (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  game_uid        TEXT NOT NULL UNIQUE,   -- 前端 randomUUID；旧数据导入时按 hash 合成
  dedup_key       TEXT NOT NULL UNIQUE,   -- sha1(exported|game_uid|notation)：幂等写入
  created_at      TEXT NOT NULL,          -- exported（ISO 8601）
  day             TEXT NOT NULL,          -- YYYY-MM-DD（UTC）
  game            TEXT NOT NULL,          -- 中文名（展示用，兼容旧前端）
  game_id         TEXT NOT NULL,          -- 引擎 id：gomoku/gomoku-pro/go/xiangqi/chess/checkers/cc
  mode            TEXT,                   -- human-ai | ai-ai | pvp
  result          TEXT,                   -- 原始中文结果串
  winner          TEXT,                   -- black | white | NULL（和棋/未终局）
  end_reason      TEXT,                   -- 五连 / 认输 / 换边中断 …
  end_by          TEXT,                   -- human | NULL（终局裁决来源）
  move_count      INTEGER NOT NULL,
  notation        TEXT NOT NULL,
  opening_prefix  TEXT,                   -- 前 4 手，供 openings 查询
  slug            TEXT,
  duel            TEXT,
  black_channel   TEXT,
  white_channel   TEXT,
  black_tactics   TEXT,
  white_tactics   TEXT,
  black_think     REAL,
  white_think     REAL,
  experiment_tag  TEXT,
  exp_game_no     INTEGER,
  code_version    TEXT,                   -- meta.code（旧记录可能为 NULL）
  tactics_version TEXT,
  top_k           INTEGER,
  seed            TEXT,
  cost_usd        REAL,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  latency_avg_ms  INTEGER,
  latency_max_ms  INTEGER,
  avg_conf        REAL,
  tactics_hist    TEXT,                   -- JSON 直方图 {win:n, block:n, ...}
  mock            INTEGER NOT NULL DEFAULT 0,
  first_win       INTEGER,                -- 1/0/NULL（校准二元真值）
  cal_json        TEXT,                   -- JSON：单局校准记录
  device_id       TEXT REFERENCES devices(device_id),
  source          TEXT NOT NULL DEFAULT 'worker',  -- worker | import
  payload         TEXT NOT NULL,
  payload_bytes   INTEGER NOT NULL,
  row_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_games_day     ON games(day DESC, id DESC);
CREATE INDEX idx_games_game    ON games(game_id, day DESC);
CREATE INDEX idx_games_device  ON games(device_id, day DESC);
CREATE INDEX idx_games_tag     ON games(experiment_tag);
CREATE INDEX idx_games_opening ON games(game_id, opening_prefix);
CREATE INDEX idx_games_cal     ON games(mock, first_win);

-- ── 逐手明细：把「每手归因」从 JSON 里解放出来 ──────────────────────────────
CREATE TABLE game_moves (
  game_id         INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  ply             INTEGER NOT NULL,
  side            TEXT NOT NULL,          -- black | white
  notation        TEXT NOT NULL,
  tactics         TEXT,                   -- 保险标记 win/block/vcfAttack/...
  tactics_version TEXT,                   -- 每手 ai.tv
  channel         TEXT,
  model           TEXT,
  confidence      REAL,
  prob            REAL,
  rank            INTEGER,
  ms              INTEGER,
  cands           INTEGER,
  PRIMARY KEY (game_id, ply)
) WITHOUT ROWID;

CREATE INDEX idx_moves_notation ON game_moves(notation);

-- ── 实验轮：按 tag upsert ──────────────────────────────────────────────────
CREATE TABLE experiments (
  tag        TEXT PRIMARY KEY,
  date       TEXT NOT NULL,
  chan_a     TEXT,
  chan_b     TEXT,
  tac_a      TEXT,                        -- 同渠道 A/B 的唯一可分辨依据，不可丢
  tac_b      TEXT,
  think_a    REAL,
  think_b    REAL,
  total      INTEGER,
  note       TEXT,
  games_json TEXT NOT NULL DEFAULT '[]',
  device_id  TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_exp_date ON experiments(date DESC);

-- ── 限流：固定窗口，跨 isolate 一致（ADR-0013）──────────────────────────────
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
) WITHOUT ROWID;

-- ── 重聚合缓存（P7）：stats/leaderboard 的物化结果 ─────────────────────────
CREATE TABLE stats_cache (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
