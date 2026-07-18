# Codex Web V1 Acceptance

验收日期：2026-07-18
验证平台：macOS，Codex CLI `0.144.3`
测试 Codex Home：`~/.codex-web/test-codex-home`（仅复用 `auth.json`，不复用正常 Session 存储）

## 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 138 passed，4 个真实集成测试默认 skipped |
| `npm run build` | 通过；仅有 Vite 500 kB chunk warning |
| `npm run schema:check` | 通过；Schema 与 Codex CLI `0.144.3` 一致 |
| `RUN_CODEX_INTEGRATION=1 ... npm run test:integration` | 4 passed；包含无活动 Turn 的 Steer 错误码、父 Turn 执行中从顶部创建 Side Chat |
| `npm run test:live-smoke` | 通过 |
| `npm run protocol:harness` | 通过 |
| `git diff --check` | 通过 |
| `npm audit --omit=dev` | 0 vulnerabilities |
| `npm pack --dry-run --json --ignore-scripts` | 通过；发布包 7 个 release bundle 文件 |
| `npm run test:package` | tarball 全新安装、安装后的 `codex-web` 启动和 health 通过 |

真实 App Server 验证使用隔离 `CODEX_HOME`，覆盖初始化、账户读取、动态模型列表、工具执行与输出 Delta、Turn 完成、中断、Fork、Goal 和 ephemeral Side Chat。无活动 Turn 的 `turn/steer` 已确认返回 `JsonRpcError` code `-32600`；父 Turn 刚启动时的 rollout materialization 竞态通过 Adapter 内的有限退避处理。Harness 中中断命令后的清理可能记录 `UnknownProcessId`，但 Turn 的协议终态正确为 `interrupted`。

## V1 产品闭环

| 能力 | 验收证据 |
| --- | --- |
| Project 与 Session 发现 | 冷启动先精确扫描每个 Project 根目录、再全量后台分页扫描；canonical cwd、三种来源、嵌套 Project 最长路径规则均有回归测试；E2E 场景覆盖先创建并解除映射一个真实 Session，再通过添加文件夹重新发现 |
| 最近 / 项目 Sidebar | 双模式、排序、搜索、Project 折叠和重新扫描可用 |
| 实时 Timeline | 用户消息乐观显示；Agent Delta、命令/工具中间状态、输出和最终回复通过 WebSocket 自动更新，无需刷新 |
| Composer | 模型与 Reasoning 来自 `model/list`；首次切换到 Full Access 会在发送前显示 Project 级提示；空闲发送、运行中 Steer 和 Interrupt 状态正确 |
| Steer 竞态 | 后端 Thread 串行锁、`expectedTurnId` 和客户端“作为下一条消息发送”恢复路径有回归测试 |
| Fork | 已完成 Turn 的 before/after 边界、首轮 before 的空 Session 预填、设置继承和 Goal 默认不继承已验证 |
| Side Chat | ephemeral Fork、隐藏边界注入、独立 Timeline/Composer、Goal 清理、不进入 Sidebar 和关闭清理已验证 |
| Goal | get/set/clear、实时通知、状态与预算编辑、Fork 继承策略已验证 |
| 运行状态 | running、waitingForInput、justFinished、interrupted、failed、disconnected 的投影与终态工具卡修正有单元测试 |
| 响应式布局 | 桌面分栏、中等宽度顶部标签、移动端 Sidebar 抽屉和 Composer 防溢出已有多 viewport E2E 覆盖 |
| 本地安全 | 仅监听 `127.0.0.1`、Host/Origin/Fetch Metadata/CSRF/Cookie/WS Token 校验、CSP 与 frame 限制，无任意 Shell 或文件读取 HTTP API |
| 协议边界 | App Server 原始 Notification、Server Request、Thread/Goal 类型只在 Codex Adapter 内解析，业务层只消费稳定 DTO |
| 测试隔离 | 真实路径规范化会拒绝正常 Home 及其符号链接；E2E 启动前核验 health 中的 canonical home |
| App Server 重启 | Runtime 断开投影、snapshot 重同步和 ephemeral Side Chat 清理已验证 |

## 手动 macOS Safari 验证

- 新 Session 正常显示 Timeline 与固定可见的 Composer；Timeline 和 Sidebar 可以独立上下滚动。
- AI 文本 Delta、最终回复和真实 shell 工具中间动作无需刷新即可出现；命令卡会显示 `inProgress`、cwd、耗时、退出码和输出。
- Steer 进入当前 Turn；Interrupt 后显示“已中断”。
- Interrupt 后主标题和 Sidebar 的运行状态同步更新。
- Goal 创建、状态修改和持久显示正常。
- Fork after、首轮 before 与原问题预填正常。
- Side Chat 分栏、独立发送和实时回复正常，且不进入 Sidebar。
- App Server 重启后 ephemeral Side Chat 被清理。
- 最近列表排序方向可以切换。
- 桌面分栏、紧凑宽度顶部标签和移动窄宽 Sidebar 抽屉均在 Safari 中检查，布局随窗口宽度自动切换。

手动验收只使用 Safari；最终回归不启动 Playwright、Chrome 调试进程或 WebDriver，也不操作用户正在使用的 Chrome。

## 已知稳定协议限制

V1 按计划只使用稳定的 `thread/read({ includeTurns: true })` 读取历史。该响应不会持久恢复所有历史 command execution 细节，因此 App Server 重启后，未被稳定协议返回的旧命令卡和完整输出无法重建。在不启用实验接口、不读取 Codex 内部存储且不复制 Session 数据的约束下，这是当前协议边界，而不是 Web UI 可以无损补齐的数据。
