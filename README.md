# Codex Web

本地、单用户、面向 Project 的 Codex Web 客户端。浏览器只连接绑定在 `127.0.0.1` 的本地 Fastify 服务；服务端长期运行 `codex app-server --stdio`，并在一个独立的 `CODEX_HOME` 中管理 Session。

## 环境要求

- macOS 13 或更高版本
- Node.js 22 或更高版本
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

## 独立 CODEX_HOME

默认数据布局：

```text
~/.codex-web/
  app.db
  codex-home/
  logs/
```

`~/.codex-web/codex-home` 与正常使用的 `~/.codex` 完全分离，因此 Web UI 创建、Fork 或测试产生的 Session 不会出现在正常 Codex Session 列表中。

首次使用时，在隔离目录中完成一次 CLI 登录：

```bash
mkdir -p ~/.codex-web/codex-home
CODEX_HOME="$HOME/.codex-web/codex-home" codex login
```

Web UI 只调用 `account/read` 检查登录状态，不发起登录流程，也不保存凭证。

可用环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_WEB_DATA_DIR` | `~/.codex-web` | 本产品的 SQLite 和日志目录 |
| `CODEX_WEB_CODEX_HOME` | `$CODEX_WEB_DATA_DIR/codex-home` | App Server 使用的隔离 Codex Home |
| `CODEX_WEB_PORT` | `7373` | 本地端口 |
| `CODEX_WEB_CODEX_BIN` | `codex` | Codex CLI 路径 |
| `CODEX_WEB_OPEN_BROWSER` | `0`（`codex-web` 命令中为 `1`） | 启动后是否打开浏览器 |

## 开发

```bash
npm run dev
npm run check
npm test
npm run build
```

前端使用 React、Vite、TanStack Query、Zustand、Radix、React Virtuoso 和 Tailwind CSS。后端使用 Fastify、WebSocket、SQLite、Zod 和 pino。

布局基于可用容器宽度自动变化：桌面 Sidebar 使用流体宽度；工作区不足 880px 时 Side Chat 切换为顶部标签；窗口不超过 720px 时 Sidebar 变为抽屉。Composer 在窄窗口仍保留权限、模型和 Reasoning 控件。

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

运行 Web E2E 时也应显式使用隔离目录：

```bash
CODEX_WEB_DATA_DIR="$PWD/.runtime/e2e-data" \
CODEX_WEB_CODEX_HOME="$HOME/.codex-web/test-codex-home" \
CODEX_WEB_OPEN_BROWSER=0 \
npm start

CODEX_WEB_E2E_EXTERNAL=1 npm run test:e2e
```

响应式 E2E 覆盖 1440x960、1024x768、720x900 和 390x844，并检查 Sidebar 抽屉、Side Chat 标签/分屏切换、Composer 控件及横向溢出。

## Codex Schema

生成的 TypeScript 和 JSON Schema 与 [packages/codex-schema/CODEX_VERSION](packages/codex-schema/CODEX_VERSION) 中记录的 CLI 版本绑定：

```bash
npm run schema:generate
npm run schema:check
```

生成脚本使用仓库内的 `.runtime/schema-codex-home`，不会污染正常 `CODEX_HOME`。

## 协议说明

- 连接建立后严格执行 `initialize`、`initialized`。
- 核心路径只使用稳定的 Thread、Turn、Fork 和 Goal 接口。
- 空 Thread 在首条用户消息前不会落盘，服务端用内存快照维持其可见性。
- ephemeral Side Chat 不支持 `thread/read(includeTurns: true)`，服务端使用内存快照和实时通知维护时间线。
- Side Chat 边界注入为 5 秒 best-effort；等价的 developer instructions 始终随 Thread 创建请求发送。
- 不读取或修改 `~/.codex` 的内部 JSONL 或 SQLite。

## 本地安全

服务只绑定 `127.0.0.1`，校验 Origin、HttpOnly SameSite Cookie、CSRF Header 和 WebSocket 会话。HTTP API 不提供任意 Shell 或文件读取能力，日志默认不记录 Prompt、完整命令输出或文件内容。
