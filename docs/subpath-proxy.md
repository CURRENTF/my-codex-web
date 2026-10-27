# Same-origin path deployment

The web build uses relative assets and a root `<base href="/">` by default.
Direct-port URLs, including deep session links, remain supported. A trusted
reverse proxy can replace this base for a path mount. API requests, WebSocket,
router links, attachments, downloads and Code View then use that prefix.

Example Nginx location (the upstream listens only on loopback):

```nginx
location = /pro6000-codex-web {
    return 302 /pro6000-codex-web/$is_args$args;
}
location ^~ /pro6000-codex-web/ {
    proxy_pass http://127.0.0.1:12103/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Accept-Encoding "";
    proxy_read_timeout 3600s;
    proxy_buffering off;
    proxy_cookie_path / /pro6000-codex-web/;
    sub_filter '<base href="/"' '<base href="/pro6000-codex-web/"';
    sub_filter_once on;
}
```

Define `$connection_upgrade` with the usual Nginx WebSocket map. Add the public
origin (no path), e.g. `https://example.com`, to `CODEX_WEB_PUBLIC_ORIGINS` while
preserving existing origins. Use a unique `CODEX_WEB_SESSION_COOKIE_NAME` for
each app instance sharing the domain. Keep authentication enabled. Browser
storage and cookies are not a security boundary between same-origin apps.

Verify login, a deep session URL reload, API and WebSocket connections, Code
View, and the original direct-port entrance. Nginx configuration validation
alone does not verify application compatibility. Keep unsupported applications
on their port entrances until they explicitly support path mounting.
