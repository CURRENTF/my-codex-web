# Codex Web

本地、单用户、面向 Project 的 Codex Web 客户端。浏览器只连接绑定在 `127.0.0.1` 的本地 Fastify 服务；服务端长期运行 `codex app-server --stdio`，并通过当前 Codex Home 访问 Session。

## 环境要求

- macOS 13 或更高版本
- Node.js 22.22 或更高版本
- 已安装 `codex` CLI
- 已在 Codex 中登录

## 安装和启动

```bash
npm install
npm run build
npm link
codex-web
```

默认地址为 `http://127.0.0.1:7373`。`codex-web` 会自动打开浏览器；设置 `CODEX_WEB_OPEN_BROWSER=0` 可关闭此行为。

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

Web UI 只调用 `account/read` 检查登录状态，不发起登录流程，也不保存凭证。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEB_DATA_DIR` | `~/.codex-web` | 本产品的 SQLite 和日志目录 |
| `CODEX_WEB_CODEX_HOME` | `$CODEX_HOME` 或 `~/.codex` | 覆盖 App Server 使用的 Codex Home；测试时应设为隔离目录 |
| `CODEX_WEB_PORT` | `7373` | 本地端口 |
| `CODEX_WEB_CODEX_BIN` | `codex` | Codex CLI 路径 |
| `CODEX_WEB_OPEN_BROWSER` | `0`（`codex-web` 命令中为 `1`） | 启动后是否打开浏览器 |
| `CODEX_WEB_PASSWORD_HASH` | 未设置 | 启用 Web UI 密码登录；值为 `scrypt-v1:<salt>:<hash>`，不要把明文密码写入仓库 |
| `CODEX_WEB_PUBLIC_ORIGIN(S)` | 未设置 | 反向代理公开 Origin；多个 Origin 用逗号分隔 |
| `CODEX_WEB_COOKIE_SECURE` | HTTPS Origin 自动启用 | 强制登录 Cookie 仅通过 HTTPS 发送 |
| `CODEX_WEB_TRUST_PROXY` | `0` | 只在服务仍绑定回环地址且前方是可信反向代理时设为 `1` |
| `CODEX_WEB_SESSION_COOKIE_NAME` | `my_codex_web_session` | 登录 Cookie 名；同一域名部署多个 Web UI 时应保持唯一 |
| `CODEX_WEB_CODE_SERVER_URL` | 未设置 | 浏览器打开 B 上文件时使用的 code-server HTTP(S) URL，例如 `https://0513jtrc.beer:12334` |
| `CODEX_WEB_CODE_SERVER_HEALTH_URL` | `<CODEX_WEB_CODE_SERVER_URL>/healthz` | 服务端健康探测 URL；同机部署建议使用 `http://127.0.0.1:12334/healthz` |

配置 code-server 后，Project、普通文件链接和代码审查位置都只通过 code-server 打开。Web UI 每 15 秒从服务端探测一次健康状态；探测失败时入口会显示为不可用，不会回退到客户端的 `vscode://`。若 code-server 迁移端口，只需更新上述两个环境变量并重启 Web UI。

## 开发

```bash
npm run dev
npm run check
npm test
npm run build
```

前端使用 React、Vite、TanStack Query、Zustand、Radix、React Virtuoso 和 Tailwind CSS。后端使用 Fastify、WebSocket、SQLite、Zod 和 pino。

布局根据可用空间自动变化：桌面 Sidebar 使用流体宽度；Session 工作区不足 1100px 时 Side Chat 切换为顶部标签；viewport 不超过 720px 时 Sidebar 变为抽屉。Composer 在窄窗口仍保留权限、模型和 Reasoning 控件。

Composer 支持选择、粘贴或拖放图片和普通文件。图片会作为 Codex 的结构化 `localImage` 输入，其他文件作为结构化文件引用；已发送附件保存在 `CODEX_WEB_DATA_DIR/attachments`，未发送草稿附件会在服务启动时清理 24 小时前的遗留数据。单个附件上限为 25 MiB，每条消息最多 10 个附件。上传和附件内容接口沿用 Web UI 的登录、CSRF 与同源保护，浏览器访问者不需要安装本地依赖。

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

## 协议说明

- 连接建立后严格执行 `initialize`、`initialized`。
- App Server 原始 Notification 和 Server Request 只在 `packages/codex-adapter` 内解析；服务层只消费规范化事件和待确认请求。
- 核心路径只使用稳定的 Thread、Turn、Fork 和 Goal 接口。
- 空 Thread 在首条用户消息前不会落盘，服务端用内存快照维持其可见性。
- ephemeral Side Chat 不支持 `thread/read(includeTurns: true)`，服务端使用内存快照和实时通知维护时间线。
- Side Chat 必须在 15 秒内确认隐藏边界注入；失败时清理临时 Thread 并向 UI 返回错误。developer instructions 同时随 Thread 创建请求发送。
- 所有 JSON-RPC 写操作都有断连 watchdog：Interrupt、rename、archive、Goal、unsubscribe 等确认类操作为 30 秒，Side Chat 隐藏边界为 15 秒，`thread/start`、`thread/fork`、`turn/start` 和 `turn/steer` 为 60 秒。超时不会自动重发，而是终止承载旧请求的 App Server、返回“结果不确定”，并在重连后重新扫描，避免释放业务锁后旧请求迟到生效。归档结果不确定时会保留 tombstone，重连确认 Session 是否仍未归档后再恢复或删除本地映射；未收到 `turn/start` 响应时会先把 Session 标为 disconnected，完成快照对账后恢复 Composer，下一次实际发送前再直接读取一次，发现迟到 Turn 时取消重复发送。普通 Fork 和 before-first Fork 都使用按父 Session 隔离的唯一 `codex-web-fork:<parentThreadId>:<clientRequestId>` source；普通 Session 创建使用按 Project 隔离的 `codex-web-session:<projectId>:<clientRequestId>` source。只恢复稳定列表中保留同一 source 的 durable child，普通非空 Fork 还会用 `thread/read` 校验父关系与完整 Turn ID 序列；隔离实测确认未发送首 Turn 的空 child 在 App Server 重启后不会持久化，因此它不存在时会清除 recovery source，而不会留下幽灵 Session。
- 关闭活动 Side Chat 会在完整 30 秒安全窗口内等待缺失的 Turn ID，ID 到达后发送 Interrupt，再最多等待 30 秒终态；缺失 `turn/completed` 时可由 idle status 或“已无活动 Turn”响应确认结束。若所有终态信号都丢失，后端只在没有其他活动 Turn、没有其他 Side Chat、没有等待响应的非幂等或已应用待确认 mutation，且并发 Session/Fork/Side Chat 已完成 Goal、SQLite、边界注入和 Runtime 注册时重启 App Server 并清理临时 Thread；否则保留目标 Side Chat 并返回可重试错误，避免中断并行创建、rename/archive/Goal 写入或留下未跟踪 child。Side Chat 尚未完成隐藏边界初始化时，unsubscribe 清理失败会保留 orphan ID 并后台指数退避重试；它只记录 warning，不会为清理临时 Thread 而重启并打断主 Session。
- `turn/start` 结果不确定且重连快照尚不能证明终态时，该 Session 保持 disconnected；Composer 与服务端 mutation 同时禁用，直到一次成功读取完成对账，避免重复启动未知上一轮任务。
- 不读取或修改 `~/.codex` 的内部 JSONL 或 SQLite。

## 本地安全

服务只绑定 `127.0.0.1`，校验 Origin、HttpOnly SameSite Cookie、CSRF Header 和 WebSocket 会话。HTTP API 不提供任意 Shell 或文件读取能力，日志默认不记录 Prompt、密码、完整命令输出或文件内容。

如需通过 HTTPS 反向代理远程访问，必须显式配置公开 Origin，并建议同时设置 `CODEX_WEB_PASSWORD_HASH`。启用密码后，未认证浏览器无法读取 Bootstrap/API，也无法建立实时 WebSocket；登录失败会按来源 IP 限速。反向代理仍应只转发到服务的回环地址，不要把 Fastify 或 Codex App Server 直接绑定到公网。
