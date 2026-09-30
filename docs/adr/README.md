# ADR 索引

架构决策记录（Architecture Decision Records）。约定：

- 一次决策一个文件，编号递增，**不可改历史**；结论变化时写新 ADR 并在旧篇头部标注被取代。
- 状态：` accepted`（生效中）/ `superseded by ADR-xxxx` / `deprecated`。
- agent 在动手前如果质疑某个设计，先读对应 ADR 的「替代方案」——那里通常已经讨论过。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-pure-static-no-build.md) | 纯静态、零框架、零构建、零依赖 | accepted |
| [0002](0002-coordinate-notation-state.md) | Jev state 用英文坐标记法 + 三问并行 | accepted |
| [0003](0003-byok-proxy.md) | 代理只做 CORS 转发的 BYOK 设计 | accepted |
| [0004](0004-unified-engine-interface.md) | 棋种引擎统一接口 + selfTest 自检 | accepted |
| [0005](0005-zero-dep-node-backend.md) | 零依赖 Node 后端（server.js）：项目变为「静态前端 + 后端」 | accepted |
| [0006](0006-rapfi-wasm-opponent.md) | Rapfi WASM 本地引擎对手（Gomocup 协议），新增 rapfi 渠道 | accepted |
