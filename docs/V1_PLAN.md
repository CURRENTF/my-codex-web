# Codex Web UI V1 实施规范

本文档保存本项目的原始 V1 Plan，供实现与独立验收使用。审计必须以本文档为唯一产品规范，不以实现摘要或既有审查结论代替。

## 一、产品定位与核心约束

产品是本地、单用户、面向 Project 的 Codex Web 客户端。核心闭环：选择本地文件夹作为 Project，查看其 Session，创建和继续 Session，观察执行状态，在执行中 Steer，从任意已完成 Turn 位置 Fork，打开不干扰主任务的 Side Chat，配置 Goal、模型、Reasoning 和 Full Access。

不复刻 Codex App 全部能力，不管理账户、插件、Sites、定时任务、云端任务或团队协作。部署固定为 Browser 通过 REST + WebSocket 连接 Local Web Server，后端通过 JSON-RPC over stdio 连接长期运行的 `codex app-server`。浏览器不得直连 App Server；不以实验 WebSocket 为生产依赖。连接后必须严格发送 `initialize`，再发送 `initialized`，之后才能调用 Thread、Turn 等接口。

后端启动时只调用一次 `account/read` 检查状态；未登录时展示阻断页，提示先在 CLI 登录。Web UI 不触发登录、不退出、不展示套餐/用量，也不保存凭证。

## 二、最终界面结构

使用单 Sidebar + Main Session + 可选 Side Chat。取消永久 Project/Session 双侧栏。

- Sidebar 建议宽 288-320px。
- Side Chat 默认占工作区 42%，分隔线可拖动并保存最后宽度。
- 工作区宽度不足 1100px 时，Side Chat 从分屏切换为 Main Session / Side Chat 顶部标签。
- 布局必须根据窗口及工作区可用宽度自动调整。

## 三、Sidebar 的 Project-Session 展示

### 最近模式

所有映射到 Project 的 Session 全局平级展示，不嵌套 Project。每行包含标题、Project 名和更新时间、运行状态、可选 Goal 图标、Fork 来源图标。默认 `updated_at desc`，可切正序。

`thread/list` 必须显式传入 `cli`、`vscode`、`appServer`，排除 subagent。流式 Delta 到达时不重排，只在 Turn 开始/终态、Session 名称改变、手动刷新、后台扫描发现新 Session 时重新计算排序。

### 项目模式

按 Project 分组，每组 Session 只有一层，不展示 Fork/subagent 树。Project 顺序由用户拖动决定；组内 Session 服从全局排序。每组默认 8 条，超出显示“展开其余 N 个”。Project 行的 `+` 直接在该目录创建 Session。

Project 菜单只保留：新建 Session、重新扫描、在文件管理器显示、修改显示名称、从侧边栏移除。移除只删 Web UI 映射，不删目录或 Codex Session。

## 四、Project 添加与 Session 发现

后端提供 `POST /api/system/pick-directory` 调用原生目录选择器：macOS `osascript`；Windows PowerShell/原生对话框；Linux 优先 zenity，其次 kdialog；不可用时允许手输绝对路径。

选择后依次：验证目录存在、`realpath` 规范化、记录显示路径与 canonical path、检测重复、写 SQLite、扫描 Session、自动选中 Project。

因为 `thread/list({cwd})` 是精确匹配，扫描分两阶段：立即精确查根目录；后台分页扫描全部 cli/vscode/appServer Session，将 canonical cwd 与 Project 做路径包含匹配。嵌套 Project 归入最长路径匹配。用户可用“移动到 Project”覆盖自动归类。

扫描时机：添加 Project、Web UI 启动、浏览器重新获得焦点且距上次超过一分钟、手动重扫。Web UI 创建或 Fork 时增量写入。

## 五、Session 主页面

顶部使用轻量面包屑 `Project / Session` 并显示运行状态/耗时。右侧仅 Side Chat、在编辑器中打开、更多；更多包含重命名、Fork 当前最新位置、归档和可延后的删除。

时间线低装饰：用户消息右侧浅灰气泡；Agent 最终回复正文；命令、文件修改、Plan、Reasoning Summary、工具调用使用折叠卡片。Turn 底部显示耗时、复制、Fork、从此处 Side Chat。

命令默认只显示命令、cwd、退出码和最后几行，可展开完整输出。文件修改卡显示文件名与加减行数，点击在右侧临时 Diff 面板查看。

历史读取按 App Server 的持久化契约分流：legacy Thread 使用 `thread/read({includeTurns:true})`；paginated Thread 先读取 metadata，再通过 `thread/turns/list({itemsView:"full"})` 分页加载。刚创建的空 paginated Thread 若索引明确不支持分页，或同一 App Server 在首条用户消息前报告 rollout 尚未 materialize，可退化为已加载的 metadata-only 空历史；已有内容的 Thread 不吞错。

## 六、Composer、模型和 Reasoning

Composer 包含输入区、Full Access、模型、Reasoning 和发送按钮。模型列表动态来自 `model/list`，前端不硬编码模型名或 Reasoning 枚举。Reasoning 仅展示所选模型支持项。

默认优先级：Session 当前设置，然后 Project 默认，再到 `model/list` 默认。Project 保存默认模型、Reasoning、权限。新 Session、普通 Fork、Side Chat 继承 Project 默认；普通 Fork 优先继承父 Session 当前设置。

执行期间模型、Reasoning、权限仍可见但禁用，因为 `turn/steer` 不能同时改变这些设置。

## 七、Full Access 与审批策略

产品权限类型仅 `fullAccess | workspaceWrite | readOnly`，协议 sandbox 结构只在 CodexAdapter 内。Project 默认 Full Access；Full Access 映射当前支持的全访问 sandbox 且 `approvalPolicy: never`。

不做审批中心或每命令弹卡，但后端必须处理 App Server Server Request。发生 MCP、用户输入或特殊工具确认时，在顶部显示“Codex 正在等待额外确认”，提供“允许一次”和“拒绝”。不得忽略请求导致 Turn 永久阻塞。

## 八、Session 运行状态

统一状态：`idle | running | waitingForInput | justFinished | interrupted | failed | disconnected`。来源包括 `thread/status/changed`、`turn/started`、`turn/completed`、待处理 Server Request 和 App Server 连接状态。

映射：Turn 开始为 running；active 且有待输入请求为 waitingForInput；completed 为 justFinished；interrupted/failed 保持对应状态；断开为 disconnected。justFinished 显示绿色勾 20 秒后回 idle。失败红标保留到打开 Session 或下一 Turn 开始。

状态必须实时显示在 Sidebar 行、主 Session 标题和 Side Chat 标题。V1 只保证由当前 Web 后端管理的 App Server 进程，不保证另一个 CLI 进程的实时事件。

## 九、运行中 Steer

空闲发送调用 `turn/start`；运行中 Composer 自动切 Steer 模式，发送调用 `turn/steer`，停止调用 `turn/interrupt`。Steer 消息归属当前 Turn，不创建新 Turn。

`turn/steer` 必须携带和当前 activeTurnId 一致的 `expectedTurnId`，并发送 `clientUserMessageId`。若发送瞬间 Turn 已结束，不得自动转成下一 Turn；保留输入，显示“当前执行刚刚结束”，提供“作为下一条消息发送”和“继续编辑”。

每 Thread 后端串行锁。活动 Turn 期间只允许 steer、interrupt、读取、普通 Fork、Side Chat，不允许第二次 `turn/start`。

## 十、指定位置 Fork

MVP 只允许已完成 Turn 边界。每个完成 Turn 提供“从此轮之后 Fork”和“从此问题之前 Fork”。之后使用当前 Turn ID；之前使用前一个已完成 Turn ID。若是首 Turn，则创建同 Project 空 Session，并预填原问题。

运行中 Turn 不能作为终点。Fork 后自动加入父 Project、出现在最近列表顶部、继承模型/Reasoning/权限、保存 `parentThreadId` 与 `forkTurnId`、默认不继承 Goal、仍平级展示，并显示来源链接“从 X 第 N 轮分叉”。可选 Goal 继承由用户勾选。

不依赖实验 `beforeTurnId`。

## 十一、Side Chat

Side Chat 使用右侧分屏，不用 Drawer。V1 每个主 Session 同时一个 Side Chat，内部可用数组为未来多标签预留。

入口：顶部 Side Chat，或完成 Turn 的“从此处 Side Chat”。通过 `thread/fork({ephemeral:true})` 创建；指定位置时传 `lastTurnId`。创建后通过 `thread/inject_items` 注入隐藏边界，并加入 developer instructions：父历史仅参考；不继续父任务/Plan；只把边界后消息视为当前任务；默认解释/轻探索；仅明确要求时改文件；不启动或控制父 Session subagent。

规则：不出现在 Sidebar；不可重命名；不写本产品 SQLite；不展示/推进父 Goal；关闭不可恢复；App Server 重启后丢失；V1 不允许 Side Chat 再 Fork。继承父 cwd、模型、Reasoning、权限，之后选择不反向影响父 Session。主/Side 可同时运行；两边 Full Access 且运行时显示弱提示可能同时改同一工作区。

关闭顺序：活动时 interrupt；等待终态；`thread/unsubscribe`；删除后端 runtime；恢复主 Session 宽度和焦点。

## 十二、Goal

主标题下显示紧凑 Goal Bar，含 Objective、Token Budget、Token 使用、Status。无 Goal 时显示“设置 Goal”。Popover 支持 Objective、Token Budget、Status、保存、清除。

Goal 的事实来源是 App Server `thread/goal/set|get|clear` 及 updated/cleared 通知，不复制到 SQLite。打开 Session 调 get，之后依赖通知。

普通 Fork 弹出“继承父 Session 的 Goal”，默认不勾选。Side Chat 不展示 Goal，创建后清除可能继承状态。修改 Objective 提示会重置统计；只改状态或 Budget 保留统计。

## 十三、后端模块

单进程内部拆分：CodexProcessSupervisor、JsonRpcTransport、CodexAdapter、ThreadRuntimeRegistry、ProjectIndexer、SessionService、EventGateway、NativeDirectoryPicker、SQLiteRepositories。

Supervisor 负责启动 App Server、继承用户环境/Codex 配置、监听 stdio/退出、初始化、账户/模型、指数退避重启，重启时活动 Session 标 disconnected。重启后不得假装原 Turn 继续，重新读取并对未知终态显示连接中断。

Transport 负责 JSONL 分行、ID、超时、Response/Notification/Server Request 分流、未知通知兼容、退出时拒绝 pending、可重试错误抖动退避。

CodexAdapter 是唯一协议边界，向业务提供稳定 API，前端/业务不得导入生成协议类型。

RuntimeRegistry 保存 activeTurnId、状态、activeFlags、pendingRequestIds、终态信息。Indexer 负责路径规范化、嵌套最长匹配和失效目录。

EventGateway 只发送规范化 `UiEvent`，每个事件有单调 `seq`。常见事件：connection.changed、session.summary.updated、runtime.changed、turn.started/completed、item.upserted/delta、goal.updated、sideChat.created/closed、pendingRequest.created/resolved。浏览器重连后重新请求快照，不永久重放 Token Delta。

## 十四、协议版本管理

客户端设置 `capabilities.experimentalApi` 以支持 0.151 起的 paginated history。`thread/turns/list` 由 Adapter 按 `historyMode` 使用并保留 legacy 降级路径；`thread/items/list`、`beforeTurnId`、permission profiles、持久化 Side Chat 仍延后并用 Feature Flag。

升级 Codex 时运行 `generate-ts` 与 `generate-json-schema`，生成物与验证过的 Codex 版本一起提交。CI 检查版本、重新生成 Schema、检测 Diff、跑协议 fixture 和真实 App Server 集成测试。

不得读取/修改 `~/.codex` 内 Session JSONL 或内部 SQLite。产品数据使用独立目录如 `~/.codex-web/app.db`、logs、preferences。

## 十五、SQLite 数据模型

SQLite 只保存 `projects`、`project_sessions`、`thread_ui_state`、`preferences`，字段遵循原始表定义：Project 路径与默认设置；Session 映射、来源、父/分叉 Turn；最近终态/查看；偏好 JSON。`origin` 为 discovered/created/forked/manual。不得复制完整 Session、Turn、消息或 Goal。Side Chat 只保存在内存 runtime。

## 十六、本地 HTTP 与 WebSocket API

需要实现：bootstrap、health、models、pick-directory、Project CRUD/rescan、Session list/read/name/create、Turn start/steer/interrupt、Fork、Goal CRUD、Side Chat create/delete、pending request respond、`WS /api/events`，并可增加实现产品需求所必需的本地路由。

`GET /api/bootstrap` 返回 connection、authReady、projects、preferences、models、runtimeStates、activeSideChats。所有修改请求接受 `clientRequestId`；Turn 与 Steer 还使用 `clientUserMessageId` 防重复。

## 十七、前端技术结构

推荐 React + TypeScript、Vite、React Router、TanStack Query、Zustand、Radix UI、Tailwind、React Virtuoso、原生 WebSocket。Query 管 Project/Session/Goal/模型快照；Zustand 仅管 Runtime、草稿、Side Chat、选中项和分栏宽度。

普通 Session 与 Side Chat 共用 Timeline/Composer，通过 capability 控制 Goal、Fork、重命名等，避免两套聊天 UI。后端推荐 Node.js + TypeScript、Fastify、ws、better-sqlite3、Zod、pino。仓库按 apps/web、apps/server、packages/codex-adapter、codex-schema、shared-types、ui、tests 分层；可在不破坏边界的前提下调整物理结构。

## 十八、本地安全

只绑定 127.0.0.1；不开 CORS；校验 Origin；启动随机会话 Token；WebSocket 使用同一 Token；Cookie HttpOnly + SameSite=Strict；写操作校验 CSRF；无任意 Shell HTTP；无任意文件读取；日志默认不记录 Prompt、完整命令输出和文件内容；目录 API 不返回文件正文；不开放远程网络访问。

Full Access 在 Composer 持续显示盾牌。每个 Project 首次启用时仅提示一次。

## 十九、开发阶段与交付

阶段 0 先做无 UI 协议 Harness，真实验证 spawn、initialize/initialized、account/read、model/list、thread/list/read/start、turn/start/steer/interrupt、thread/fork、thread/goal/*，并录制脱敏 fixture。阶段 1 完成 Project/Sidebar；阶段 2 完成 Timeline、流式、中间动作、模型/Reasoning/权限、发送/停止/状态；阶段 3 完成 Steer/Fork/Goal；阶段 4 完成 Side Chat；阶段 5 完成长 Session、重启恢复、刷新、多标签冲突、失效目录、日志脱敏、Playwright、打包。

最终提供 `codex-web` 命令，启动本地服务、App Server 并自动打开浏览器。

## 二十、测试计划

单测覆盖 Runtime 状态机、路径/嵌套匹配、排序、Steer 竞态、Fork 边界、Side Chat 清理、Goal 继承。

协议测试分 Fake App Server fixture 与真实 App Server；真实测试进入受控 CI，验证字段、通知顺序、错误码和版本兼容。

Playwright 至少覆盖：添加文件夹并发现 Session；两种 Sidebar；正/倒序；创建 Session 设置；运行状态；Steer 不新建 Turn；Steer 竞态保留消息；Fork 边界；Side Chat 并行且不进列表；Goal 恢复和实时事件；刷新重同步；App Server 崩溃恢复；Project 删除不删文件/Session；多标签页同 Thread 写操作串行。

## 二十一、明确不做

V1 不做账户登录/退出、套餐/用量、云同步、多用户、团队权限、插件、Sites、PR 页面、计划任务、完整终端、代码编辑器、Git GUI、worktree、subagent 树、持久化 Side Chat、Side Chat 再 Fork、消息队列、语音、MCP 管理、复杂审批中心。

只围绕 `Project -> Session -> Goal / Model / Reasoning / Full Access -> Turn -> Status -> Steer -> Fork -> Side Chat` 形成稳定闭环。

## 二十二、最终验收标准

V1 必须满足：添加已有文件夹后自动发现 CLI、VS Code 和 Web UI Session；最近/项目两模式及更新时间排序；状态无需刷新实时变化；运行中消息 Steer 当前 Turn；任意已完成 Turn 可 Fork；Side Chat 右侧运行且不污染主 Session；Goal 重开仍存在；模型/Reasoning 动态来自 App Server；Full Access 为默认主路径；App Server 或浏览器断开后明确显示并重同步。

核心维护原则：不读取 Codex 内部存储；前端不接触原始协议；实验接口不作为核心依赖；不复制 Session 数据；App Server 变化只由 CodexAdapter 吸收。

## 审计环境硬约束

- 本机 macOS 验证。
- 所有会创建测试 Session 的命令必须使用独立 `CODEX_HOME`，不得污染用户正常 Session list。
- 生产默认仍使用用户的 `$CODEX_HOME` 或 `~/.codex`，只有测试显式覆盖为隔离 home。
- 不启动或遗留无用 Chrome、Chromium、Playwright remote-debugging 进程。
- 前端采用克制、接近 Codex 原生的设计；响应式按实际可用工作区变化。
- 最终独立 reviewer 必须无对话上下文，只接收本 Plan 和 repo 路径。
