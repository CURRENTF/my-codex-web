# H100 Web 服务运行位置

公开入口为 `https://0513jtrc.beer/hitsz-h100-codex-web/`，通过 SSH 别名 `h100` 管理。这里的服务与 Worker-A 的部署独立。

| 项目 | 当前位置 |
| --- | --- |
| Git checkout | `/home/haojitai/projects/my-codex-web`，`main` |
| Web 服务 | 用户级 `my-codex-web-12100.service` |
| 本机监听 | `127.0.0.1:12100` |
| 独立隧道 | 用户级 `my-codex-web-12100-tunnel.service` |
| Web 运行数据 | `/data1/haojitai/services/my-codex-web-12100-active/data` |
| 服务日志 | `/data1/haojitai/services/my-codex-web-12100-active/logs` |
| 存储覆盖配置 | `~/.config/systemd/user/my-codex-web-12100.service.d/99-storage-fallback.conf` |
| 存储环境文件 | `~/.config/my-codex-web-12100/storage-fallback.env` |

`/data2` 满盘会使更新状态写入触发 `ENOSPC`，Web 在监听端口前退出，导致公开入口返回 502。当前运行数据已回退到 `/data1`；`/data2/haojitai/services/my-codex-web-12100` 保留原数据，不再作为 Web 写入目录。现有 `/data1/haojitai/services/*/logs/*.log` 轮转规则覆盖新服务日志。

排查时先检查两个数据盘的可用空间、Web 状态和上述服务错误日志，再检查隧道。仅恢复 Web 不需要重启独立隧道或共享 Codex App Server。

迁移 Web 数据前停止 Web 服务，连同 SQLite 的 WAL 文件复制运行数据，并在目标目录执行数据库完整性检查；不要移动或修改 Codex 自身的 `~/.codex`。新增存储环境文件作为最后一个 `EnvironmentFile` 加载，确保它覆盖原环境文件中的 `CODEX_WEB_DATA_DIR`，同时更新标准输出和错误日志路径。

恢复后检查公开 `/api/health`、原 session 链接和服务重启计数。登录页可打开只证明 Web 入口恢复；模型调用与对话运行状态需要在认证后另行确认。更新是否完成应单独核对 Git commit 和更新状态，不能根据 502 消失判断。
