# games/ —— 历史归档（只读，已冻结）

这个目录里的 `games/<YYYY-MM-DD>/*.json` 是**迁移前**的棋谱归档：旧实现每跑完一局就把
一份 JSON commit 进这个仓库目录（见 ADR-0009 / 已退役的 `functions/api/games.js`）。

**2026-10-01 起：**

- 全部 54 份棋谱（4379 手）已导入 D1（`jev-qiguan`，见 `scripts/import-archive.mjs`），
  **D1 是唯一权威**；新对局只写 D1，**不再往本目录写文件**。
- 本目录冻结，仅作为「可重建整库」的原始输入保留（`migrations/import/*.sql` 由这些文件生成，
  且 `scripts/verify-parity.mjs` 会用它们逐字节核对 D1 里的 `payload`）。
- 新前端读棋谱走 `/api/games`（列表）/ `/api/games/u/<gameUid>`（详情），不要再按文件路径取。
- 因此**不要**手动改动这里的文件：改一个字节就会让 `verify:parity` 的 payload 保真断言失败。
  确需修正历史数据时，请改 D1 并同步更新本目录与 `migrations/import/`，然后重跑
  `npm run verify:parity`。

旧的线上只读站（`https://jev-qiguan.pages.dev`）仍按老路径读这个目录，作为回退手段保留。
