# Worker-A 远程部署运行手册

## Purpose

将运行在局域网 WSL2 主机 `Worker-A` 上的 my-codex-web，通过公网中转机 M 的独立反向 SSH 隧道和 Nginx HTTPS 入口提供给浏览器。本文记录 2026-08-22 已验证的当前部署；V1 的正式验收平台仍是 macOS。

## Current topology

```text
Browser
  -> https://0513jtrc.beer:12101
  -> M nginx: 172.19.14.251:12101
  -> M reverse listener: 127.0.0.1:12101
  -> Worker-A SSH tunnel
  -> Worker-A my-codex-web: 127.0.0.1:7373
  -> codex app-server --stdio
```

管理 SSH 使用 `ssh -J root@8.134.70.136 -p 22024 k@127.0.0.1`。WebSocket 流量使用独立隧道，不与管理 SSH 的反向转发共用连接。

## Paths and services

| Item | Current value |
| --- | --- |
| Source on Worker-A | `/home/k/projects/my-codex-web` |
| Deployed source commit | `81bfcfe9f7dd5e566040a486f8ab31b0e3a004f5` |
| Node.js | `/home/k/.nvm/versions/node/v22.22.1/bin/node` |
| Codex CLI | `/home/k/.nvm/versions/node/v22.22.1/bin/codex` |
| Codex Home | `/home/k/.codex` |
| Web data | `/home/k/.codex-web` |
| Web service | `my-codex-web.service` (user systemd) |
| Tunnel service | `my-codex-web-12101-tunnel.service` (user systemd) |
| Password hash file | `/home/k/.config/my-codex-web/env`, mode `0600` |
| Nginx site on M | `/etc/nginx/sites-available/my-codex-web-12101.conf` |
| TLS certificate on M | `/etc/letsencrypt/live/0513jtrc.beer/` |

`my-codex-web.service` sets the public origin to `https://0513jtrc.beer:12101`, keeps Fastify bound to `127.0.0.1:7373`, enables trusted-proxy handling, and uses absolute Node/Codex paths because a user systemd service does not inherit the interactive NVM shell environment. The password file stores only a `scrypt-v1` hash; never store the plaintext password in the repository or unit file.

## Build and update

Deploy the same clean commit as the local active branch. The current host was bootstrapped from a `git archive`, so updates should likewise copy an exact archive rather than assuming the remote default branch.

The Web UI update button requires the source path to be a clean Git checkout on `main` with a working `origin` credential. An archive-based deployment must be migrated to that layout explicitly before enabling the button; the updater will refuse to alter a non-Git directory. Once the checkout is ready, add this environment entry to `my-codex-web.service` and restart the service once:

```ini
Environment='CODEX_WEB_UPDATE_RESTART_COMMAND_JSON=["systemctl","--user","restart","my-codex-web.service"]'
```

The button fetches `origin/main`, validates the target in an isolated worktree with `npm ci --include=dev`, `npm run check`, `npm test`, and `npm run build`, then performs a fast-forward-only deployment and restarts only `my-codex-web.service`. The explicit development-dependency install keeps `tsc` and Vitest available even when systemd sets `NODE_ENV=production`. It never restarts the tunnel service. Update state and bounded command logs remain under `/home/k/.codex-web` across the application restart.

On Worker-A, after replacing the tracked source files:

```bash
cd /home/k/projects/my-codex-web
export PATH=/home/k/.nvm/versions/node/v22.22.1/bin:$PATH
export HTTP_PROXY=http://127.0.0.1:7890
export HTTPS_PROXY=http://127.0.0.1:7890
export ALL_PROXY=socks5://127.0.0.1:7891
npm ci --include=dev --no-audit --no-fund
npm run check
npm test
npm run build
systemctl --user restart my-codex-web.service
```

Restart the tunnel only when its configuration or connection is unhealthy:

```bash
systemctl --user restart my-codex-web-12101-tunnel.service
```

## Verify

On Worker-A:

```bash
systemctl --user show my-codex-web.service \
  -p ActiveState -p SubState -p MainPID -p NRestarts
curl -fsS http://127.0.0.1:7373/api/auth/status
```

Expected auth status before login:

```json
{"passwordRequired":true,"authenticated":false}
```

On M:

```bash
ss -ltnp | grep ':12101 '
nginx -t
systemctl is-active nginx
```

From an external client, verify with the real public origin and a trusted certificate:

```bash
curl -fsS https://0513jtrc.beer:12101/api/auth/status
```

After logging in, `/api/health` should report `connection: "connected"` and `codexHome: "/home/k/.codex"`. A public HTTP or TLS check alone does not prove that Codex turns can run; inspect `journalctl --user -u my-codex-web.service` when account, proxy, model-list, or turn execution fails.

## Troubleshooting

- `node` or `codex` is missing only under systemd: keep the absolute executable paths and explicit `PATH` in the unit.
- Public page returns `502`: check the M-side `127.0.0.1:12101` listener, then `my-codex-web-12101-tunnel.service`, then Worker-A `127.0.0.1:7373`, in that order.
- Login page works but Codex is reconnecting: check the web service journal and the local proxy listeners on `127.0.0.1:7890` and `127.0.0.1:7891`.
- Nginx changes must pass `nginx -t` before reload. Keep the Fastify service on loopback; do not expose port `7373` directly.
