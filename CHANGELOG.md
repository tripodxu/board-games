# CHANGELOG

本项目可感知的变更历史。版本语义：0.x 期间 minor 反映功能交付，patch 反映修复。
日常记录另见 [docs/memory/MEMORY.md](docs/memory/MEMORY.md)（新条目置顶）。

## [0.1.0] - 2026-09-28

### Added
- 六个棋种引擎：五子棋（15×15）、围棋（9×9，中国规则贴 5.5）、象棋、国际象棋、西洋跳棋、中国跳棋；统一接口 + selfTest
- 三种对弈模式：人机（可选执子）、机机（速度滑杆/暂停/单步）、人人
- Jev 接入四渠道：官方 API / OpenRouter / 同源代理 / 离线演示；429/529 指数退避；top-k 概率加权采样
- Jev 决策面板：top-3 概率条、置信度、局势判断（Noul/Score）、延迟、token 与成本累计
- CF Pages Functions BYOK 代理（functions/api/jev.js）与本地 dev-proxy.py
- 自检体系：node test/run-tests.js 与 index.html?test=1
- 文档体系：AGENTS.md、docs/（架构/引擎接口/Jev API/ADR/计划/多 agent 协同/记忆）
