# Codex Web

本地、单用户、面向 Project 的 Web 客户端，支持按对话选择 Codex、pi 或 agy 后端。浏览器只连接绑定在 `127.0.0.1` 的本地 Fastify 服务；服务端默认运行 `codex app-server --stdio`，也可连接现有本机 App Server，并通过当前 Codex Home 访问 Session。

## 环境要求

- macOS 13 或更高版本
- Node.js 22.22 或更高版本
- 使用 Codex 时：已安装 Codex CLI `0.149.0` 或更高版本，并完成登录
- 使用 pi 时：为运行 Web 服务的用户配置 pi 模型凭证；pi 随项目依赖安装
- 使用 agy 时：在服务所在机器单独安装 agy CLI，并以服务运行用户完成登录；`npm run setup` 不会安装 agy

推荐在部署 Web 前，先完成计划使用的各后端的登录、模型和代理配置，并各做一次最小回答测试。不使用的后端可以不安装或配置，不影响其他后端。

## 安装和启动

```bash
npm run setup
codex-web
```

`npm run setup` 是新 checkout 的一键安装入口：它严格按照仓库中的 `package-lock.json` 执行 `npm ci --include=dev`，完成生产构建，并把 `codex-web` 命令链接到当前用户的 npm prefix。依赖版本已经固定在 repo 中；不提交不可移植且体积很大的 `node_modules`。若 Node.js 低于 22.22，脚本会在安装前给出明确错误。

默认地址为 `http://127.0.0.1:7373`。`codex-web` 会自动打开浏览器；设置 `CODEX_WEB_OPEN_BROWSER=0` 可关闭此行为。

设置中的「液态玻璃」开关可在经典外观与玻璃外观之间即时切换，默认关闭，选择仅保存在当前浏览器。玻璃外观受 macOS Liquid Glass 启发，是原生 CSS 的网页近似实现，并非 Apple 官方组件；深浅色跟随系统。侧栏、输入框和浮层使用磨砂材质，正文与代码保留稳定底色。系统开启减少透明度、强制颜色，或浏览器不支持背景模糊时，自动使用实色面板。

设置中的「显示机器资源」开关默认关闭，仅保存到当前浏览器。开启后，右侧悬浮栏显示运行 Web 服务的主机 CPU 利用率和最高 GPU 利用率；点击展开可查看每张卡的显存、功率及利用率，以及主机内存。前台每 3 秒刷新，后台标签页暂停轮询，关闭后停止请求。服务端合并并发采样并缓存 2 秒。GPU 需要服务用户可以执行 `nvidia-smi`，支持多张 NVIDIA GPU；AMD / Apple GPU 和 CPU 功率暂不采集，缺失指标显示不可用。CPU / 内存为主机视角，不代表容器配额或单个 Session 用量。资源接口沿用 Web 登录保护。


通过反向 SSH 隧道和 HTTPS 反向代理部署到远程 Linux/WSL 主机时，参见 [Worker-A 远程部署运行手册](docs/DEPLOYMENT_LINUX_REVERSE_TUNNEL.md)。

## 数据目录与 CODEX_HOME

默认数据布局：

```text
~/.codex-web/
  app.db
  attachments/
  logs/
```

产品默认使用启动环境中的 `CODEX_HOME`，未设置时使用 `~/.codex`，因此可以发现现有 CLI、VS Code 和 App Server Session。本产品自己的 Project 与 UI 元数据仍只写入 `~/.codex-web/app.db`。

同一个 Codex Home 中，一个对话只能由一个 App Server 持有写锁。若桌面端已经打开该对话，独立 Web App Server 恢复它会遇到 `already has an active writer`，定时轮询也无法发送。可配置 `CODEX_WEB_CODEX_SOCKET=/absolute/path/to/app-server.sock`，让 Web 通过 Unix WebSocket 连接桌面端正在使用的 App Server（见 [官方协议](https://learn.chatgpt.com/docs/app-server#protocol)）。socket 必须属于同一服务用户且可访问；共享模式下 Web 重连和重启只断开自身连接，共享 App Server 的启动、升级和重启由原宿主管理。不要删除 Codex 的 writer lock 文件或直接修改其内部数据库来解锁。轮询遇到占用会显示原因并在下个周期重试，保存轮询设置保留上次发送结果。

Web UI 只调用 `account/read` 检查登录状态，不发起登录流程，也不保存凭证。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEB_DATA_DIR` | `~/.codex-web` | 本产品的 SQLite 和日志目录 |
| `CODEX_WEB_CODEX_HOME` | `$CODEX_HOME` 或 `~/.codex` | 覆盖 App Server 使用的 Codex Home；测试时应设为隔离目录 |
| `CODEX_WEB_PORT` | `7373` | 本地端口 |
| `CODEX_WEB_CODEX_BIN` | `codex` | Codex CLI 路径 |
| `CODEX_WEB_CODEX_SOCKET` | 未设置 | 连接现有本机 App Server 的绝对 Unix socket 路径，共享桌面端会话；不设置时启动独立 stdio App Server |
| `CODEX_WEB_OPEN_BROWSER` | `0`（`codex-web` 命令中为 `1`） | 启动后是否打开浏览器 |
| `CODEX_WEB_PASSWORD_HASH` | 未设置 | 启用 Web UI 密码登录；值为 `scrypt-v1:<salt>:<hash>`，不要把明文密码写入仓库 |
| `CODEX_WEB_PUBLIC_ORIGIN(S)` | 未设置 | 反向代理公开 Origin；多个 Origin 用逗号分隔 |
| `CODEX_WEB_COOKIE_SECURE` | HTTPS Origin 自动启用 | 强制登录 Cookie 仅通过 HTTPS 发送 |
| `CODEX_WEB_TRUST_PROXY` | `0` | 只在服务仍绑定回环地址且前方是可信反向代理时设为 `1` |
| `CODEX_WEB_SESSION_COOKIE_NAME` | `my_codex_web_session` | 登录 Cookie 名；同一域名部署多个 Web UI 时应保持唯一 |
| `CODEX_WEB_UPDATE_REPOSITORY` | `CODEX_WEB_PROJECT_ROOT` | 自动更新使用的干净 Git checkout 根目录 |
| `CODEX_WEB_UPDATE_REMOTE` | `origin` | 自动更新拉取的 Git remote |
| `CODEX_WEB_UPDATE_BRANCH` | `main` | 自动更新要求检出并快进的分支 |
| `CODEX_WEB_UPDATE_RESTART_COMMAND_JSON` | 未设置 | 更新完成后的重启命令 JSON 参数数组；设置后才启用左上角更新按钮，例如 `["systemctl","--user","restart","my-codex-web.service"]` |

Project、Session 的 `code` 入口、回复中的文本文件链接和代码审查行号直接打开内置 Code View（新标签页）。不需要 code-server 或额外端口；旧 `CODEX_WEB_CODE_SERVER_URL` / `CODEX_WEB_CODE_SERVER_HEALTH_URL` 配置不再使用。

Code View 使用按需加载的 CodeMirror，支持目录浏览、当前目录筛选、语法高亮、行号跳转、查找、撤销和 `⌘/Ctrl+S` 保存已有文件。允许浏览和编辑服务进程有权限访问的文件（包括工作目录外路径和隐藏目录），可返回上级直到文件系统根目录，无需先添加 Project。读写仅接受 1 MiB 以内的 UTF-8 普通文件，拒绝硬链接保存。目录列表不跟随符号链接，文件请求会校验真实路径。文件读写复用 Web 登录和 CSRF 防护。保存前检查内容版本并在同目录原子替换；与外部进程的最后一次检查和替换之间仍有极短竞争窗口，不提供跨进程文件锁。未保存修改会在切换文件和离开页面时提醒。首版不提供新建、删除、终端、扩展或语言服务器。

HTML 文件（`.html` / `.htm`，大小写均可）默认渲染预览，可在顶部切换“预览 / 源码”；带行号的链接仍直接定位源码。预览使用当前编辑内容，不要求先保存，切换视图保留修改与撤销历史。沙箱支持内联 CSS、JavaScript 和 HTTPS 外部脚本、样式、图片等资源，禁止访问父页面、登录状态、网络 API、嵌套页面、弹窗及表单提交。本地相对路径资源暂不支持，适合资源内嵌的单文件 HTML；需要后端接口的应用仍须启动自己的开发服务器。沿用 1 MiB UTF-8 文件限制。

所有普通文件均可通过 Code View 顶部的下载图标下载，包括超过预览大小限制的文件和二进制文件。无法预览时页面会显示下载入口；下载以流式传输提供，不受 1 MiB 文本预览限制，不将整个文件加载到编辑器。下载的是磁盘上的原始文件，不含尚未保存的编辑。对话中的 `.nsys-rep`、`.qdrep`、`.ncu-rep` 和压缩包链接会直接下载，文本链接继续打开 Code View。下载沿用 Web 登录及服务用户的文件读取权限。下载前会检查文件是否可读，失败时在页面显示原因。路径属于 Web 服务所在机器；SSH 远端文件须先复制到该机器，下载接口不会自动连接 SSH。

对话中的 `mermaid` Markdown 代码块会按需加载并渲染为图表，支持中文标签和 `<br/>` 换行；也支持整条消息直接粘贴以 `flowchart TD`、`graph LR` 等方向声明开头的流程图。图表适配系统深浅色主题，可展开“源码”；流式输出未完成或语法无效时保留源码。

## 按对话选择 Codex / pi / agy

点击「新建」直接使用默认后端（初始为 Codex）。在左上角「设置 → 新 Session 默认设置」中可切换默认后端，也可开启「每次新建时询问后端」以逐次选择；这些偏好保存在当前浏览器，立即生效。同一 Project 中可以同时运行 Codex、pi 和 agy 对话，不需要切换全局配置或重启 Web。后端绑定到创建的对话，历史 Codex 对话仍由 Codex 管理。侧边栏的后端标识和会话标题旁的后端名称用于区分。

空白对话的「准备开始」下方可直接选择 Codex、pi 或 agy，无需开启逐次询问。切换会替换当前空白会话的后端容器，保留未发送文字、附件、名称和置顶状态，移除原空壳，不增加侧边栏对话，也不改变已保存的默认后端。原生会话 ID 和链接随后端更新，浏览器替换当前历史记录；新后端启动失败时保留原会话。已有消息或 Goal 的对话不可切换。普通新建直接调用所选后端，创建结果立即显示，不等待其他后端的状态探测或额外的历史读取。

每个后端可在「设置 → 新 Session 默认设置」独立保存默认模型与 effort，选择「使用项目默认」或「使用 pi / agy 默认」则沿用原生配置。当前对话通过输入框右下角的模型菜单选择模型，选择只影响该对话的下一轮。模型菜单提供刷新入口，仅查询当前后端：Codex 使用 App Server `model/list`，pi 使用 RPC `get_available_models` 与 `get_state`，agy 使用 `agy models` 与 `agy -p /model`。Web 模型列表缓存 30 秒，手动刷新立即重新查询；登录失效或没有模型时显示后端返回的原因。

`package.json` 声明运行依赖，`package-lock.json` 锁定安装版本。pi（`@earendil-works/pi-coding-agent@1.4.0`）与必需插件 `pi-unified-exec@0.13.1` 均随 `npm run setup` 安装，发布的 npm 包也包含这两项运行依赖。Web 创建 pi 会话时显式加载锁定版本插件并检查其命令是否注册；如果 pi 的全局或项目 npm 目录已有同版本副本，则复用该路径，让 Pi 按实际路径去重，避免工具重复注册导致启动退出。无需另行执行全局 `pi install`，也不修改用户的 pi 配置。其他已配置的 pi 扩展仍正常发现；不同版本的插件或其他同名工具冲突需要在 pi 配置中消除。模型探测不加载扩展。

在服务所在机器、以服务运行用户执行 `npx --no-install pi`，通过 `/login` 配置所需提供商，或配置该提供商支持的 API Key 环境变量及 pi 的 `models.json`。pi 默认使用 `~/.pi/agent`；可通过 `PI_CODING_AGENT_DIR` 指定独立配置目录。Web 不共享 Codex 凭证，也不在浏览器里接收提供商密钥。配置完成后，在模型菜单点击刷新图标即可重新检测模型；已启动进程的环境变量变化仍需要由服务管理器重新加载。

在仓库目录执行 `npx --no-install pi --list-models` 检查模型配置；需要经常在终端使用时，可选安装与项目锁定版本一致的全局 CLI：`npm install -g @earendil-works/pi-coding-agent@1.4.0`。全局安装不是 Web 使用 pi 的前提，也不会自动提供登录凭证。模型列表可能包含当前账号无权调用的型号，应选一个已获授权的模型验证实际回答，而不是仅凭列表判定就绪。

每个活动 pi 对话运行独立 RPC 子进程。原生历史与 Web 展示元数据位于 `CODEX_WEB_DATA_DIR/pi`，重启后继续使用同一原生历史；不会把压缩后的 UI 文本重新拼成模型上下文。现有 pi CLI 历史不会自动导入。可用 `CODEX_WEB_PI_BIN=/absolute/path/to/pi` 覆盖执行文件，但必须提供与内置 1.4.0 一致的 RPC 接口（包括 `agent_settled`）。

`pi-unified-exec` 的 `exec_command({ cmd: "…", on_exit: "wake" })` 可在后台命令退出后自动继续任务。默认 `on_exit` 为 `"none"`；只有明确需要自动续跑时才开启。pi 空闲时的自动续跑会创建新的 Web turn，更新运行状态，并保存插件完成通知、工具输出和后续回复；当前轮仍在运行时，follow-up 继续归入当前轮。切换页面或断开浏览器连接不终止服务端 pi 进程。归档会话、停止 pi 或重启 Web 会终止原进程，插件后台命令及其唤醒计划不会跨重启恢复；已保存的对话历史保留。

pi 支持流式文本、思考与工具结果、模型选择、Steer、中断、上下文压缩、重命名、归档、附件、定时轮询和标准扩展输入弹窗。目前仅提供 Full Access，不宣称具备 Codex 的只读／工作区沙箱；Goal、原生 Review、Fork、Side Chat、子代理面板和 Web Skill 选择暂不开放。pi 自身的技能命令与扩展仍由 pi 加载。Codex 重连不会中断 pi 对话；单个 pi 进程退出会将对应对话标为失败，后续可重新发送。

### agy CLI

agy 需要在服务所在机器单独安装，并以服务运行用户完成登录；先确认 `agy models` 可用。Web 从服务进程的 `PATH` 查找 `agy`，也可通过 `CODEX_WEB_AGY_BIN=/absolute/path/to/agy` 指定执行文件。安装 CLI 和设置启动环境后需首次重新启动 Web；之后在设置里切换默认后端无需重启。模型列表来自 agy；未在 Web 指定默认模型时沿用其配置，effort 暂时使用模型默认值。成功的模型探测缓存 30 秒；未安装或未登录不影响 Codex / pi 使用。

部署或迁移后，按以下顺序验收（实际回答会消耗少量模型额度）：

1. 以 Web 服务用户确认 `agy --help`、`agy models` 和 `agy -p /model` 正常；CLI 需支持本文使用的 stream-json 协议。
2. 用 `agy --model <可用模型ID> --mode plan --print-timeout 1m -p '只回复 OK，不调用工具或读取文件'` 验证实际回答；pi 在仓库目录用 `npx --no-install pi --no-session --no-tools --model <provider/model> -p '只回复 OK'` 验证。必须收到非空回答，不能只看退出码或模型数量。
3. 检查服务的 `HOME`、`PATH`、代理环境与测试命令一致。systemd 不会自动读取交互式 shell 的配置；修改服务环境后需要重启 Web。认证错误、模型权限错误、代理出口或区域限制都可能导致“能列出模型，但不能回答”。
4. 迁移时分别处理 CLI、登录凭证、模型设置和所需扩展；只复制 Web 仓库不会迁移用户环境。凭据通过受信任通道传输并限制文件权限，勿提交到 Git；不要覆盖目标机器已有会话或照搬源机器的绝对路径。已有会话的迁移另按下文的数据要求处理。

agy 每轮运行独立 CLI 进程，通过 `--input-format stream-json` / `--output-format stream-json` 传递消息与事件，用明确的 `--conversation` ID 恢复原生上下文，不使用会续接最近对话的 `--continue`。Web 显示历史和原生 ID 映射保存在 `CODEX_WEB_DATA_DIR/agy`；原生上下文仍由 agy 管理，备份或迁移时需同时保留 agy 自身的会话数据。只展示从 Web 创建的会话，不导入已有 CLI 历史。

输入框权限入口统一使用带盾牌图标的菜单：Codex 可切换权限，pi 和 agy 显示 Full Access，后两者只列出当前支持的原生模式。模型只有一个 effort（例如 agy 的 Gemini 档位已包含在模型名中）时隐藏 effort 选择；有多个档位的模型仍可选择。

目前支持流式回复、工具步骤、模型选择、续聊、停止、排队发送、重命名、归档、文件路径附件和定时轮询。停止先发送 SIGINT，等待 CLI 结束后才允许下一轮；无响应时终止该进程组并明确报告停止未确认。单个进程异常不会中断其他后端；无最终结果、异常退出或超时不会当作成功。

agy 仅支持 Full Access：每轮以 `--mode accept-edits --dangerously-skip-permissions` 启动 CLI，文件操作与命令均无需逐次审批。新建和已有 agy 对话的后续轮次统一使用此模式，界面不提供 headless 下无法完成命令审批的 Accept Edits 选项。Web 不桥接 agy 单项审批，也不提供 Codex 的只读／工作区沙箱。命令被拒绝时展示原生工具错误；即使 CLI 返回 `SUCCESS`，若没有最终回复且最后一个工具失败，Web 仍将该轮标为失败，旧版保存的同类空白完成记录也会在加载时纠正。暂不开放图片附件、Steer、Web 上下文压缩、Goal、Review、Fork、Side Chat、子代理面板、Web Skill 选择和美元费用估算。

可选真实 CLI 冒烟测试（会使用已登录 agy 的模型额度，仅操作临时测试目录）：`RUN_AGY_INTEGRATION=1 npx vitest run tests/integration/agy-native.test.ts`。普通 `npm test` 使用隔离的 CLI 协议 fixture，不依赖 agy 安装、凭据或网络。

## 启用更新按钮

更新按钮只适用于“服务直接从 Git checkout 启动”的部署。`npm pack`、`npm install -g` 或 `git archive` 生成的目录没有可快进的 Git 元数据；即使另外指定一个 checkout，若 systemd 重启后仍从旧的全局安装目录启动，也不会切换到新版本。

启用前确认：

- 运行目录是检出目标分支的 Git checkout，且 `git status --short` 没有输出。
- 服务重启后仍从这个 checkout 的 `bin/codex-web.mjs` 启动。
- 服务用户可以执行 `git fetch <remote> <branch>`，并且 `node`、`npm`、`git` 在服务环境的 `PATH` 中可用。
- 重启命令只重启 Web 应用，不要顺带重启独立的 SSH tunnel、Nginx 或其他服务。

更新过程中执行的 Git/npm 命令都有硬超时。超时后服务先终止命令进程组，短暂宽限后强制结束残留进程并把更新标记为失败，避免 Web 服务永久停在“正在更新”状态。

用户级 systemd 服务可以按下面的结构配置；所有路径和服务名都要替换为本机实际值：

```ini
[Service]
WorkingDirectory=/absolute/path/to/my-codex-web
ExecStart=/absolute/path/to/node /absolute/path/to/my-codex-web/bin/codex-web.mjs
Environment=CODEX_WEB_OPEN_BROWSER=0
Environment=CODEX_WEB_UPDATE_REPOSITORY=/absolute/path/to/my-codex-web
Environment=CODEX_WEB_UPDATE_REMOTE=origin
Environment=CODEX_WEB_UPDATE_BRANCH=main
Environment='CODEX_WEB_UPDATE_RESTART_COMMAND_JSON=["systemctl","--user","restart","my-codex-web.service"]'
```

修改 unit 后执行：

```bash
systemctl --user daemon-reload
systemctl --user restart my-codex-web.service
systemctl --user show my-codex-web.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts
```

重新打开左上角更新对话框后，“当前版本”应显示 Git commit，“检查并更新”按钮应可用。若仍显示“当前版本：未知”，先在 `CODEX_WEB_UPDATE_REPOSITORY` 中运行 `git rev-parse HEAD`；若仍显示“未配置”，检查 `CODEX_WEB_UPDATE_RESTART_COMMAND_JSON` 是否作为合法 JSON 字符串数组传入了 Web 服务进程。

更新器只接受 `remote/branch` 相对于当前 commit 的快进后继。它先在 `CODEX_WEB_DATA_DIR/updates` 创建隔离 worktree，执行 `npm ci --include=dev`，再运行 TypeScript 检查、完整测试和生产构建；显式包含开发依赖可保证设置了 `NODE_ENV=production` 的 systemd 服务仍能获得 `tsc` 和测试工具。候选版本全部通过后，才快进运行 checkout、重新安装/构建并执行重启命令。存在未提交或未跟踪文件、运行中的 Turn、分支不匹配或非快进历史时都会拒绝更新。进度保存在 `CODEX_WEB_DATA_DIR/self-update.json`，详细日志写入 `CODEX_WEB_DATA_DIR/logs/update-<run-id>.log`。浏览器在重启完成后自动刷新到新版本。

设置中的「重启 my-codex-web」使用同一个 `CODEX_WEB_UPDATE_RESTART_COMMAND_JSON`，确认后只执行配置的 Web 服务重启命令，不拉取代码或构建，也不要求 Git checkout。命令必须仅重启 Web 应用服务，不能包含隧道或代理服务。未配置时按钮不可用；有运行中的任务或更新时拒绝重启。重启期间暂停定时轮询任务并拒绝新的写入请求，浏览器检测到新服务实例后自动刷新；命令启动失败或服务未恢复时显示错误。

## 开发

```bash
npm run dev
npm run check
npm test
npm run build
```

前端使用 React、Vite、TanStack Query、Zustand、Radix、React Virtuoso 和 Tailwind CSS。后端使用 Fastify、WebSocket、SQLite、Zod 和 pino。

布局根据可用空间自动变化：桌面 Sidebar 使用流体宽度；Session 工作区不足 1100px 时 Side Chat 切换为顶部标签；viewport 不超过 720px 时 Sidebar 变为抽屉。Composer 在窄窗口仍保留权限、模型和 Reasoning 控件。

Composer 支持选择、粘贴或拖放图片和普通文件。图片会作为 Codex 的结构化 `localImage` 输入，其他文件保留结构化文件引用，同时把文件绝对路径和读取提示作为文本传给模型，供模型按需读取；已发送附件保存在 `CODEX_WEB_DATA_DIR/attachments`，明确发送失败的附件恢复为可删除草稿，结果不确定的附件则保留到对账完成，未发送草稿附件会在服务启动时清理 24 小时前的遗留数据。单个附件上限为 25 MiB，每条消息最多 10 个附件。上传和附件内容接口沿用 Web UI 的登录、CSRF 与同源保护，浏览器访问者不需要安装本地依赖。

同一浏览器标签页刷新后会恢复已上传、未发送的附件；未完成的上传会提示重新选择文件。浏览器仅保存附件描述，不保存图片字节。Nginx 等反向代理的请求体上限应至少为 `26m`，为 25 MiB 文件及 multipart 边界留出空间；否则请求可能在到达应用前被代理以 413 拒绝。

## macOS 隔离集成测试

测试可以共享正常 Codex 的登录凭证，但不能共享正常配置或 Session 存储。只链接 `auth.json`：

```bash
mkdir -p ~/.codex-web/test-codex-home
test -e ~/.codex-web/test-codex-home/auth.json || \
  ln -s ~/.codex/auth.json ~/.codex-web/test-codex-home/auth.json
```

不要链接正常的 `config.toml`。真实 App Server 集成测试：

```bash
RUN_CODEX_INTEGRATION=1 \
CODEX_WEB_TEST_CODEX_HOME="$HOME/.codex-web/test-codex-home" \
npm run test:integration
```

真实模型 live smoke 使用：

```bash
CODEX_WEB_SMOKE_CODEX_HOME="$HOME/.codex-web/test-codex-home" \
npm run test:live-smoke
```

真实模型偶尔会排队数分钟；脚本默认等待每个 Turn 最多 10 分钟，并可用 `CODEX_WEB_SMOKE_TURN_TIMEOUT_MS` 调整。超时路径会先 Interrupt 活动 Turn，再清理测试 Session。

运行 Web E2E 时也应显式使用隔离目录：

```bash
CODEX_WEB_DATA_DIR="$PWD/.runtime/e2e-data" \
CODEX_WEB_CODEX_HOME="$HOME/.codex-web/test-codex-home" \
CODEX_WEB_OPEN_BROWSER=0 \
npm start

CODEX_WEB_E2E_EXTERNAL=1 \
CODEX_WEB_E2E_CODEX_HOME="$HOME/.codex-web/test-codex-home" \
npm run test:e2e
```

响应式 E2E 覆盖 1440x960、1024x768、720x900 和 390x844，并检查 Sidebar 抽屉、Side Chat 标签/分屏切换、Composer 控件及横向溢出。

测试入口会解析真实路径并拒绝 `~/.codex`、当前 `$CODEX_HOME` 及其符号链接；外部 E2E 还会先核验 `/api/health` 返回的 `codexHome`。

## 安装包验证

`npm pack` 会先构建前端和独立的服务端 release bundle。下面的命令会把 tarball 安装到全新临时目录，运行安装后的 `codex-web` 并检查健康状态，全程不会打开浏览器：

```bash
npm run test:package
```

## Codex Schema

生成的 TypeScript 和 JSON Schema 与 [packages/codex-schema/CODEX_VERSION](packages/codex-schema/CODEX_VERSION) 中记录的 CLI 版本绑定：

```bash
npm run schema:generate
npm run schema:check
```

生成脚本使用仓库内的 `.runtime/schema-codex-home`，不会污染正常 `CODEX_HOME`。
运行时会从 App Server 的 `initialize.userAgent` 校验 Codex CLI 版本；低于 `0.149.0` 的版本会被拒绝并在服务日志中给出升级提示。schema 生成版本是协议快照，不等同于最低支持版本。

## 协议说明

- 连接建立后严格执行 `initialize`、`initialized`。
- App Server 原始 Notification 和 Server Request 只在 `packages/codex-adapter` 内解析；服务层只消费规范化事件和待确认请求。
- 核心路径只使用稳定的 Thread、Turn、Fork 和 Goal 接口。
- 空 Thread 在首条用户消息前不会落盘，服务端用内存快照维持其可见性。
- ephemeral Side Chat 不支持 `thread/read(includeTurns: true)`，服务端使用内存快照和实时通知维护时间线。
- 从分页 Thread 创建 ephemeral Side Chat 时必须传 `excludeTurns: true`，随后由 `thread/turns/list` 和实时通知维护时间线。
- Side Chat 必须在 15 秒内确认隐藏边界注入；失败时清理临时 Thread 并向 UI 返回错误。developer instructions 同时随 Thread 创建请求发送。
- 所有 JSON-RPC 写操作都有断连 watchdog：Interrupt、rename、archive、Goal、unsubscribe 等确认类操作为 30 秒，Side Chat 隐藏边界为 15 秒，`thread/start`、`thread/fork`、`turn/start` 和 `turn/steer` 为 60 秒。超时不会自动重发，而是终止承载旧请求的 App Server、返回“结果不确定”，并在重连后重新扫描，避免释放业务锁后旧请求迟到生效。归档结果不确定时会保留 tombstone，重连确认 Session 是否仍未归档后再恢复或删除本地映射；未收到 `turn/start` 响应时会先把 Session 标为 disconnected，完成快照对账后恢复 Composer，下一次实际发送前再直接读取一次，发现迟到 Turn 时取消重复发送。普通 Fork 和 before-first Fork 都使用按父 Session 隔离的唯一 `codex-web-fork:<parentThreadId>:<clientRequestId>` source；普通 Session 创建使用按 Project 隔离的 `codex-web-session:<projectId>:<clientRequestId>` source。只恢复稳定列表中保留同一 source 的 durable child，普通非空 Fork 还会用 `thread/read` 校验父关系与完整 Turn ID 序列；隔离实测确认未发送首 Turn 的空 child 在 App Server 重启后不会持久化，因此它不存在时会清除 recovery source，而不会留下幽灵 Session。
- 关闭活动 Side Chat 会在完整 30 秒安全窗口内等待缺失的 Turn ID，ID 到达后发送 Interrupt，再最多等待 30 秒终态；缺失 `turn/completed` 时可由 idle status 或“已无活动 Turn”响应确认结束。若所有终态信号都丢失，后端只在没有其他活动 Turn、没有其他 Side Chat、没有等待响应的非幂等或已应用待确认 mutation，且并发 Session/Fork/Side Chat 已完成 Goal、SQLite、边界注入和 Runtime 注册时重启 App Server 并清理临时 Thread；否则保留目标 Side Chat 并返回可重试错误，避免中断并行创建、rename/archive/Goal 写入或留下未跟踪 child。Side Chat 尚未完成隐藏边界初始化时，unsubscribe 清理失败会保留 orphan ID 并后台指数退避重试；它只记录 warning，不会为清理临时 Thread 而重启并打断主 Session。
- `turn/start` 结果不确定且重连快照尚不能证明终态时，该 Session 保持 disconnected；Composer 与服务端 mutation 同时禁用，直到一次成功读取完成对账，避免重复启动未知上一轮任务。
- 不读取或修改 `~/.codex` 的内部 JSONL 或 SQLite。

## 本地安全

服务只绑定 `127.0.0.1`，校验 Origin、HttpOnly SameSite Cookie、CSRF Header 和 WebSocket 会话。HTTP API 不提供任意 Shell 或文件读取能力，日志默认不记录 Prompt、密码、完整命令输出或文件内容。

如需通过 HTTPS 反向代理远程访问，必须显式配置公开 Origin，并建议同时设置 `CODEX_WEB_PASSWORD_HASH`。启用密码后，未认证浏览器无法读取 Bootstrap/API，也无法建立实时 WebSocket；登录失败会按来源 IP 限速。反向代理仍应只转发到服务的回环地址，不要把 Fastify 或 Codex App Server 直接绑定到公网。

### 对话内问题卡片

Codex 有两条不同的提问路径：

- `item/tool/requestUserInput` 是待响应的服务端请求，显示在对话顶部。支持选项、协议允许的自由文本回答及密码输入；点击“发送答案”才会发送，“跳过”返回空答案。缺少 `isBlocking` 的旧版请求按同步处理，明确为 `false` 时不把运行状态改成等待。多个请求分别展示。
- `request_user_input_async` 在 Codex 0.153.x 中通过 `agentMessage` 的 `delivery: "async"` 和 `questions` 字段发送，显示为对话历史中的问题卡片。首个选项默认选中，也始终允许自由回答。点击“填入输入框”将问题和答案追加到已有草稿，再通过普通发送按钮提交；不会自动发送。这样沿用现有的追加消息、下一轮发送和失败恢复流程。旧历史中的结构化问题也可以显示，卡片不会随原 Turn 结束而消失。

网页刷新后，服务端请求从 Web 运行时快照恢复；历史问题从 App Server 历史读取。卡片内未填入输入框的答案只保存在组件内存中。服务端请求由 `serverRequest/resolved` 或任务结束等运行时清理移除，不根据旧的 `autoResolutionMs` 自动回答。该功能取决于所连接 Codex 的模型与协议能力，Web 界面不会自行启用模型的异步提问工具。

左上角“设置”中的“显示消息进度栏”开关默认开启，可隐藏或重新显示对话左侧的消息导航栏；选择保存在当前浏览器。

### 定时轮询任务

在任务输入框底部点击闹钟图标，打开悬浮设置面板，填写轮询间隔（整数分钟，1–525600）和 prompt，点击“启用轮询”。每个普通任务独立保存一份配置；Side Chat 不支持。启用后可随时修改或暂停，发送使用任务最近保存的模型、推理与权限设置。

“完成后自动暂停”开关默认关闭。开启后，服务器发送轮询 prompt 时会在末尾追加完成确认语句；当该次轮询的模型回复包含 `Toutes les tâches ont été parfaitement accomplies.`，服务器自动暂停该任务的轮询。重启后也会在下次发送前检查上一次轮询的回复。

侧边栏中，已启用定时轮询的任务会在状态按钮中央显示闹钟；任务运行中闹钟缓慢旋转，刚刚完成时闹钟变绿，暂停或自动停止轮询后恢复普通状态图标。

轮询由 Web 服务器执行，配置与下次执行时间保存在 `CODEX_WEB_DATA_DIR` 的应用数据库中。关闭浏览器不影响执行；Web 服务重启后自动恢复。首次发送在一个完整间隔后进行，服务停机或连接中断期间错过的周期最多合并为一次，不连续补发。任务运行中或等待用户输入时跳过本次，发送失败在下一周期重试，结果可在面板查看。归档任务会暂停轮询，移除项目会删除对应配置。暂停不会撤回已经发出的请求。服务器必须保持运行才能按时执行。

## Session API 费用显示

在左上角「设置」开启「显示 API 费用」，即可在各 Session 顶部查看累计美元估算，点击金额展开按模型分组的输入、缓存输入和输出 token。默认关闭，开关仅保存在当前浏览器。开启时每 30 秒刷新，Turn 状态变化时也会更新；关闭后停止查询。

费用优先使用 App Server 的 `account/usage/read({ threadId })` 返回的 `threadUsage.estimatedUsageUsdMicros`。没有原生金额或接口查询失败时，先尝试原生返回的按模型分组 token，再使用 Web 记录的 `thread/tokenUsage/updated.total` 累计量估算。不会把账户总用量当成当前会话用量。

Web 按模型和服务档位记录累计用量的增量，并保存到 `CODEX_WEB_DATA_DIR` 的应用数据库。重复通知不会重复计费，刷新浏览器或重启 Web 服务不会清空记录；开关只控制显示和费用查询，不影响已连接会话的用量记录。首次收到的历史累计量按当时模型与档位估算，后续切换模型按增量分组。计数回退时保留已记录消耗，并标记估算限制。

估算采用 [OpenAI API 价格表](https://developers.openai.com/api/docs/pricing) 2026-10-15 的公开短上下文价格，区分普通输入、缓存输入、缓存写入及输出；推理输出不重复相加。当前收录 GPT-6 Astra、GPT-6.1 Sol、GPT-6 Sol/Luna、GPT-5.6 Sol/Terra/Luna、GPT-5.5 和 GPT-5.3 Codex，支持 Standard、Fast/Priority 和已知的 Flex/Batch 价格系数；GPT-5.5 的 Fast 按 2.5 倍估算，GPT-6 Astra 和 GPT-6.1 Sol 的 Ultrafast 按 6 倍估算。未计长上下文加价、地区附加费及工具费用。价格表更新后，已有账本在下次费用查询时直接重新估算，无需新的 token 通知。金额显示保留 0 位小数，内部保留精度。

未知模型或明细缺失时不猜价格。顶部区分「缺少价格」「用量待更新」和「用量不完整」，明细列出缺失价格的模型或服务档位；混合用量只展示可估算部分，并在金额旁标注「部分」。

已有会话若未返回原生费用或 token 分组，打开会话也可能没有历史用量通知，需要产生下一次用量更新后才能估算。UI 区分「Codex 提供」与「按 token 估算」，并说明缺失或历史假设；子会话独立记录，不合并到父会话。此功能不读取 Codex 内部 Session 文件或数据库。

### Session 历史缓存

浏览器将成功同步的 Session 快照保存到 IndexedDB，最多保留最近 20 个、约 50 MiB（按 JSON UTF-16 大小估算），7 天后过期；React Query 的 Session 内存缓存保留 30 分钟。刷新页面或切回长对话时先显示缓存，再后台同步。存储不可用时退化为网络读取；后台同步失败时保留历史并显示重试提示。归档 Session 或移除 Project 时清理对应缓存，也可通过浏览器清除此站点的数据删除全部历史缓存。

`GET /api/sessions/:threadId?sync=1&prefixCount=N&prefixHash=...` 使用 SHA-256 校验前 N 个稳定 turns 的完整内容。匹配时响应的 `thread.turns` 只包含剩余部分，`sync.retainedCount` 指示客户端复用的前缀长度；不匹配或历史缩短时返回完整快照。`sync.prefixCount/prefixHash` 标识本次快照的稳定前缀，正在进行的 turn 及其后续内容不进入前缀。运行状态、设置与 Goal 每次返回。未使用 `sync=1` 的客户端仍收到原完整响应。

持久快照与 WebSocket 更新分开保存，避免实时修改使前缀凭据与缓存内容不一致。此机制减少重复传输和浏览器解析，服务端仍通过 App Server 读取并校验最新历史，以识别其他客户端的更新；尚未跳过上游完整读取。

历史对账以相同类型和 ID 的消息作为已持久化边界：边界之前仅存在于缓存中的普通助手消息会被清理，避免已被上游淘汰的流式回复长期重复显示。边界之后的实时内容、工具记录、用户消息和异步问题卡片仍保留；没有共同消息时不推测删除。此规则仅用于历史读取，不用于可能省略消息的实时 Turn 通知。
