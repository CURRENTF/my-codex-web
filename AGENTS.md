# Repository guidance for Codex agents

## Scope and safety

- Preserve unrelated uncommitted and untracked work. Do not reset or overwrite the checkout to make an update succeed.
- Treat `~/.codex` as Codex-owned state. Use App Server APIs and the repository abstractions; do not parse or modify internal Session JSONL or SQLite files.
- Run `npm run check`, `npm test`, `npm run build`, and `git diff --check` before handing off implementation changes.
- Keep stable setup and deployment instructions in `README.md` or `docs/`. Do not put passwords, hashes, cookies, private keys, or authenticated response bodies in the repository.

## Self-update deployment contract

The top-left update control is enabled only when `CODEX_WEB_UPDATE_RESTART_COMMAND_JSON` is configured. A usable deployment also requires the running Web service to load code directly from the same clean Git checkout named by `CODEX_WEB_UPDATE_REPOSITORY`.

Before enabling or troubleshooting self-update, verify all of the following:

1. `git -C <repository> status --short` is empty.
2. `git -C <repository> branch --show-current` matches `CODEX_WEB_UPDATE_BRANCH`.
3. `git -C <repository> remote get-url <remote>` works for the service user.
4. The service `ExecStart` runs `<repository>/bin/codex-web.mjs`, not a separate global npm/package/archive installation.
5. The restart command restarts only the Web application service. Keep tunnel and proxy services independent.

For a user systemd service, the essential environment is:

```ini
Environment=CODEX_WEB_UPDATE_REPOSITORY=/absolute/path/to/my-codex-web
Environment=CODEX_WEB_UPDATE_REMOTE=origin
Environment=CODEX_WEB_UPDATE_BRANCH=main
Environment='CODEX_WEB_UPDATE_RESTART_COMMAND_JSON=["systemctl","--user","restart","my-codex-web.service"]'
```

After editing the unit, run `systemctl --user daemon-reload`, restart the application once, and verify that the update dialog shows a commit instead of `未知` and no longer reports `未配置`.

Do not enable the button on an `npm install -g`, `npm pack`, or `git archive` deployment unless the deployment is first migrated so the service itself runs from the tracked checkout. The updater fast-forwards and builds its configured repository; it does not reinstall an unrelated global package.

When changing the updater, preserve these guarantees:

- Only fast-forward the configured branch from the configured remote.
- Reject dirty, wrong-branch, divergent, or active-Turn deployments.
- Validate the detached candidate before changing the running checkout.
- Persist bounded status and logs under `CODEX_WEB_DATA_DIR` across restart.
- Never restart the tunnel or reverse proxy as part of an application code update.
