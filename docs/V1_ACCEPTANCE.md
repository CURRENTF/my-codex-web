# Codex Web V1 Acceptance

初始验收日期：2026-07-25
初始验证平台：macOS，Codex CLI `0.144.3`
测试 Codex Home：`~/.codex-web/test-codex-home`（仅复用 `auth.json`，不复用正常 Session 存储）

以下固定数量和 Safari 结果记录的是 2026-07-25 初始验收，不代表当前提交刚刚复测。当前实现已经升级到 Codex CLI `0.151.0` 并启用 experimental API；当前自动化结果见文末校订记录。

## 2026-07-25 自动化验证

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 264 passed，4 个真实集成测试默认 skipped |
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

## 2026-09-04 当前自动化校订

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 497 passed，6 个真实 App Server 集成测试因默认配置 skipped |
| `npm run build` | 通过；保留现有 Vite 大 chunk warning |

本轮没有运行需要隔离 Codex Home 的真实 App Server 集成、live smoke 或浏览器 E2E。新增回归覆盖：确定失败后附件恢复为可删除草稿、结果不确定时继续保留并在确认未应用后释放，以及忽略 SIGTERM 的更新子进程会在宽限期后被强制终止。

## V1 产品闭环

| 能力 | 验收证据 |
| --- | --- |
| Project 与 Session 发现 | 冷启动先精确扫描每个 Project 根目录、再全量后台分页扫描；canonical cwd、三种来源、嵌套 Project 最长路径规则均有回归测试；E2E 场景覆盖先创建并解除映射一个真实 Session，再通过添加文件夹重新发现；Project 扫描、创建、Fork、移动和删除共享 Project 锁，精确根目录重扫不会撤销用户手工 Project 归类；删除后新增 Project 使用 `max(orderIndex)+1`，不会产生重复排序索引 |
| 最近 / 项目 Sidebar | 双模式、排序、搜索、Project 折叠和重新扫描可用；相对更新时间每 30 秒自动推进；失效目录的 Project 禁止创建 Session、Turn、Fork 和 Side Chat，前端 Composer 同步禁用且后端拒绝绕过 UI 的请求；目录恢复后的手动重扫会同时刷新 Project 可用性与 Session |
| 实时 Timeline | 用户消息乐观显示；Agent Delta、命令/工具中间状态、输出和最终回复通过 WebSocket 自动更新，无需刷新；Reasoning 卡只接收 Summary 与 summary Delta，不向 Web 暴露完整 reasoning content/text Delta |
| Composer | 模型与 Reasoning 来自完整分页读取的 `model/list`；首次切换到 Full Access 会在发送前显示 Project 级提示；空闲发送、运行中 Steer 和 Interrupt 状态正确；Interrupt 失败会显示错误而非静默继续运行；单个 Session 在断线后尚未完成快照对账时 Composer 保持禁用，后端也拒绝新 Turn，避免未知上一轮结果时重复执行；未确认的 `turn/start` 即使多次读取都停在旧 baseline 也不会自动恢复，必须由用户点击“确认未执行，恢复输入”触发一次新的直接快照核验；仍未出现时返回并复用原 `clientUserMessageId` 重试，依赖 App Server 去重覆盖核验后迟到物化的竞态；迟到 Turn 已出现时返回 `uncertain_turn_applied`、只清除与原提交匹配的草稿并取消重复发送，用户后来编辑的新草稿不受影响；新建 Session 使用 request-specific `threadSource`，响应丢失时只恢复稳定列表中保留同一唯一 source 的 durable child；真实协议验证确认未发送首个 Turn 的空 child 在 App Server 重启后不会持久化，但 recovery 仍等待 30 秒迟到物化窗口；已经精确观察到的 child 会继续进入有最终 TTL 的后台恢复，TTL 后恢复 discovery，不创建幽灵映射；协议已经返回 durable child、但 SQLite 收尾与远端归档同时失败时仍保留精确恢复身份并返回 `operation_uncertain`；普通失败或 `operation_uncertain` 会在工作区顶部显示，提交 ref 同时阻止重复点击创建 |
| Steer 竞态 | 后端使用 Thread 串行锁、`expectedTurnId` 和双请求 ID。只有明确的 `turn_finished` 409 会由客户端使用新的请求 ID 自动把同一输入发送为下一 Turn；Project/活动状态等其他冲突仍保留输入并显示真实错误。`turn/steer` 响应丢失时按 `expectedTurnId + clientUserMessageId` 进入显式快照对账：已应用则清除匹配提交而不重发，未应用则恢复原活动 Turn、原草稿、附件和原消息 ID 后才允许安全重试 |
| Fork | 已完成 Turn 的 before/after 边界、首轮 before 的空 Session 预填、设置继承和 Goal 默认不继承已验证；每次创建登记按父 Session 隔离的唯一 `codex-web-fork:<parentThreadId>:<clientRequestId>` source，普通 Session 创建登记按 Project 隔离的 `codex-web-session:<projectId>:<clientRequestId>` source；响应丢失但 matching `thread/started` 已证明 child ID 时，普通非空 Fork 再由 `thread/read` 校验父关系与完整 Turn ID 序列后补齐 Goal 和 parent/fork Turn 元数据；before-first 的 exact 空 child 只有已进入稳定列表才会接管；未观察到 child 时等待 30 秒迟到物化窗口后清理 source，已经精确观察到但尚未稳定列出的 child 转入带最终 TTL 的后台恢复；如果响应和通知都丢失，则仅认领 `thread/list` 中保留同一唯一 source 的 durable child，再执行相同 lineage/Turn 校验；身份未决的 source 会被 Project 扫描跳过，精确根目录重扫也保留已有 created/forked 来源元数据；恢复出的原问题同时进入实时事件与 bootstrap 快照，刷新或 WebSocket 重连后仍可恢复且不覆盖已编辑草稿；预填带客户端来源标记，另一标签页开始 Turn、重连快照证明已有 Turn或 bootstrap 不再返回该预填时，只清除仍未编辑的注入草稿，用户修改或主动清空的草稿保留；非空 Fork 的精确 child 暂未出现在列表或历史尚未物化时由连接恢复器持续有界退避，30 秒窗口过期后停止阻断全局连接并保留后台精确恢复；协议已经返回 durable Fork child、但 Goal/SQLite 收尾与远端归档同时失败时同样保留精确恢复身份并受最终 TTL 约束；无 matching notification 或 source 时不猜测或改写任何外部 Session；Project 已移除时也放弃恢复且不修改 Goal/映射；无 Goal 直接创建路径与 Goal 继承弹窗都显示普通失败或 `operation_uncertain`，不会静默鼓励重复创建 |
| Side Chat | ephemeral Fork、隐藏边界注入、独立 Timeline/Composer、Goal 清理、不进入 Sidebar和关闭清理已验证；主 Session 与 Side Chat 共享 Project 级 Full Access 首次提示与确认状态，窄屏只显示 Side Chat 标签时也不会绕过提示；`no rollout found` 只在父 Session 已被内存 snapshot 证明为空时才等价退化为新的空 ephemeral Thread，绝不丢弃已有历史；关闭时若 Runtime 仅有 active 状态而缺少 Turn ID，会在 30 秒安全窗口内继续等待 `turn/started`，ID 到达后仍先 Interrupt（不调用 ephemeral Thread 不支持的 `thread/read`）；缺失 `turn/completed` 时接受 idle status 或“已无活动 Turn”作为终态确认，所有信号都丢失时仅在无其他活动 Turn、无其他 Side Chat、没有等待响应的非幂等或已应用待确认 mutation，且 Session/Fork/Side Chat 的完整本地收尾均已结束时重启 App Server 清理，否则保留目标 Side Chat 并返回明确可重试错误，不中断 Session/Fork 创建、rename/archive/Goal 更新或销毁其他 idle Side Chat；隐藏边界初始化失败后的 unsubscribe 清理失败会保存 orphan ID 并后台退避重试，不会重启并打断并行主 Turn；创建失败在 Session 内明确显示 |
| Goal | get/set/clear、实时通知、状态与预算编辑、Fork 继承策略已验证 |
| 运行状态 | running、waitingForInput、justFinished、interrupted、failed、disconnected 的投影与终态工具卡修正有单元测试；failed 在打开 Session 后清除，interrupted 即使已查看或后端重启也保留到下一 Turn 开始；Turn 中断后命令迟到自然退出不会改变 Turn 的 `interrupted` 终态，同时命令卡保留真实 `exitCode` 与耗时，并明确标注“Turn 已中断”；只有 active status 而漏掉 `turn/started` 时禁止第二个 Turn，Interrupt 会先读 snapshot、再有限等待迟到的 Turn ID；身份恢复期间 Turn 若已自然结束则 Interrupt 视为成功，只有确认仍 active 且无法获得 ID 时才返回 `active_turn_unknown`；`turn/start` 前会从冷 Session 的 resume 快照建立精确旧 Turn baseline，响应超时或 App Server 在确认前退出时，即使没收到通知也强制标记 disconnected；重连后若新 App Server 多次有界读取都稳定停在旧 baseline，仍保持带 `uncertainTurnStart` 标记的 disconnected 状态，只有用户显式确认后才再次读取并恢复 Composer；发现迟到 Turn 时取消重复发送；出现新的 inProgress Turn、旧活动 Turn 无终态或不稳定快照时继续 disconnected 并拒绝新 mutation；subagent 的确认或输入 Server Request 通过 `thread/started.parentThreadId` 路由到可见父 Session，响应仍使用原 request ID；idle status 会清除旧 activeTurnId、pending request 与实时 Delta 后再释放终态等待，Side Chat 删除后的迟到 request-resolved 事件不会复活 Runtime；确认请求解决时也保留未知-ID活跃态，直到终态信号到达；允许/拒绝或用户输入响应失败会保留横幅并显示可重试错误，不会让阻塞静默持续 |
| 响应式布局 | 桌面分栏、中等宽度顶部标签、移动端 Sidebar 抽屉和 Composer 防溢出已有多 viewport E2E 覆盖；Full Access、并行写与错误 notice 由统一容器纵向堆叠，不会占用同一 grid 区域互相覆盖 |
| 本地安全 | 仅监听 `127.0.0.1`、Host/Origin/Fetch Metadata/CSRF/Cookie/WS Token 校验、CSP 与 frame 限制，无任意 Shell 或文件读取 HTTP API；生产默认只信任服务自身 Origin/Host，Vite `5173` 仅由 `npm run dev` 显式开启；畸形 percent-encoded WebSocket Cookie 按未认证处理而不会抛出；错误日志只保留 Error 名称和标量 code，不序列化 App Server 的不透明 `error.data`、Prompt、命令输出或文件内容 |
| 协议边界 | App Server 原始 Notification、Server Request、Thread/Goal 类型和 JSON-RPC transport 超时只在 Codex Adapter 内解析；Adapter 把未确认 mutation 转成稳定 `OperationUncertainError`，HTTP/业务层不识别 transport 错误；非对象 JSONL 帧按协议错误丢弃；App Server 断开即清空旧 Server Request；所有有副作用的本地 POST/PATCH/PUT/DELETE（含原生目录选择器）均携带 `clientRequestId` 并去重；隐藏边界注入使用 15 秒 watchdog，interrupt、unsubscribe、rename、archive、Goal 等确认型写操作使用 30 秒 watchdog，创建/Turn 等非幂等 mutation 使用 60 秒 watchdog；任何写操作超时或 stdio 断开都会终止承载旧请求的 App Server、返回 `operation_uncertain` 且不自动重发，避免超时请求在释放业务锁后迟到生效；未确认的 `turn/start` 只有在显式核验后才允许复用原 `clientUserMessageId` 重试，保持 App Server 级消息去重；归档不确定时保留 tombstone，重连后扫描完整未归档列表，已应用则删除本地映射，未应用则恢复发现；Adapter 跟踪所有进行中的 mutation，SessionService 另外保护 Session/Fork/Side Chat 从请求到 Goal、SQLite、边界注入和 Runtime 注册结束的完整生命周期；Side Chat 恢复重启在任一层仍未完成时被禁止；普通 Session 与 Fork 都使用按 Project/父 Session 隔离的 request-specific source，优先从协议响应或原始 `thread/started.threadSource` 保存精确 child ID；两者都丢失时仅从稳定列表中持久保留的同一唯一 source 恢复，在此之前 ProjectIndexer 按 source 阻止通用导入；普通非空 Fork 再由稳定读取校验 lineage/Turn 边界；未观察到的空 child 保留 30 秒迟到物化窗口，精确观察到但未稳定列出的 child 转入有最终 TTL 的后台恢复；非空 child 的历史尚未物化时同样进行限定窗口内的有界退避与后台精确恢复；真实集成固定了 `thread/start` 与 `thread/fork` 均保留 source；Session/Fork 映射写入后广播 summary 更新供其他标签页刷新，映射写入失败时只有远端归档被确认后才丢弃恢复身份，无法确认时由最终 TTL 恢复 discovery |
| 测试隔离 | 真实路径规范化会拒绝正常 Home 及其符号链接；E2E 启动前核验 health 中的 canonical home |
| App Server 重启 | Runtime 断开投影、完整 Turn snapshot 重同步、恢复失败的退避重试和 ephemeral Side Chat 清理已验证；后续正常读取可从临时失败中自愈 |
| Project 删除一致性 | 删除期间暂停自动打开旧 Session、取消当前 Session 查询并抑制确认框返回焦点触发的旧 Project 扫描；Session 读取、mutation 与删除共用 Thread 锁，迟到或分批的 Goal/Fork 加载和通知不会复活已删除状态；归档 tombstone 阻止旧扫描页恢复映射；Safari 实测删除后路由回到 `/`，日志无旧 Project `rescan`、未映射 Session 读取或 500；重新添加同一目录后 Session 可再次发现 |

## 手动 macOS Safari 验证

- 新 Session 正常显示 Timeline 与固定可见的 Composer；Timeline 和 Sidebar 可以独立上下滚动。
- AI 文本 Delta、最终回复和真实 shell 工具中间动作无需刷新即可出现；命令卡会显示 `inProgress`、cwd、耗时、退出码和输出。
- 最新构建在 Safari 中运行 `ROUND21_LIVE_START/END` 的 4 秒 shell 测试，Timeline 无刷新完成从 running 到刚刚完成的切换，并显示命令、cwd、4.0s、`exit 0`、最终输出和 `ROUND21_LIVE_DONE`；当前 App Server `0.144.3` 的原始输出通知只提供最后一段，因此卡片只展示协议实际可得的 `ROUND21_LIVE_END`。
- Steer 进入当前 Turn；Interrupt 后显示“已中断”。
- Interrupt 后主标题和 Sidebar 的运行状态同步更新。
- 最新构建中，真实 45 秒 shell 命令运行时实时显示 `inProgress` 与 cwd；点击停止后主 Session 与 Sidebar 立即显示“已中断”，命令随后自然退出并无需刷新更新出 `SAFARI_INTERRUPT_FINAL_END`、45.0s 和“Turn 已中断 · exit 0”。刷新后服务端 snapshot 的 Turn 仍为 `interrupted`，上述命令终态与迟到输出仍在。Safari Web Inspector 控制台无运行时错误。
- Goal 创建、状态修改和持久显示正常。
- Fork after 会准确截止到选定 Turn、加入最近列表并显示来源；父 Session 有 Goal 时继承选项默认关闭，新 Fork 无 Goal；首轮 before 会创建空 Session 并预填原问题。
- 顶部和指定 Turn 两种入口都能创建 Side Chat；分栏内独立发送后实时返回，且不进入 Sidebar；关闭后 UI 与后端 runtime 均清理。
- 工作区不足 1100px 时，主 Session / Side Chat 自动切换为顶部标签；App Server 重启后 ephemeral Side Chat 被清理。
- 杀死测试 App Server 子进程后，UI 立即显示“连接中断”，Supervisor 自动重启后重新同步并恢复连接。
- 最近列表排序方向可以切换。
- 删除当前 Project 后地址正确回到 `/`，目录和 Codex Session 保留；重新添加同一目录后原 Session 自动恢复到 Sidebar。
- 删除确认框关闭不会再触发旧 Project 的后台扫描，删除后也不会重试读取已解除映射的当前 Session。
- 桌面分栏、紧凑宽度顶部标签和移动窄宽 Sidebar 抽屉均在 Safari 中检查，布局随窗口宽度自动切换；窄窗口 Composer 仍固定在底部且主内容可独立滚动。

手动验收只使用 Safari；最终回归未启动 Playwright 浏览器、Chrome 调试进程或 WebDriver，也未操作用户正在使用的 Chrome。

## 当前协议限制

当前实现以 `experimentalApi: true` 初始化 Codex CLI 0.151.0，并在可用时使用分页历史接口；这些响应仍不会持久恢复所有历史 command execution 细节，因此 App Server 重启后，协议未返回的旧命令卡和完整输出无法重建。项目继续遵守不读取 Codex 内部 JSONL/SQLite、不复制 Session 数据的边界。
