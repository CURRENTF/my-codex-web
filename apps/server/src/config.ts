import { homedir } from "node:os";
import path from "node:path";
import { defaultCodeServerHealthUrl, normalizeHttpUrl } from "./code-server.js";

const dataDir = process.env.CODEX_WEB_DATA_DIR ?? path.join(homedir(), ".codex-web");
const publicOrigins = (process.env.CODEX_WEB_PUBLIC_ORIGINS ?? process.env.CODEX_WEB_PUBLIC_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean)
  .map((origin) => new URL(origin).origin);
const sessionCookieName = process.env.CODEX_WEB_SESSION_COOKIE_NAME?.trim() || "my_codex_web_session";
if (!/^[A-Za-z0-9_-]{1,64}$/.test(sessionCookieName)) throw new Error("CODEX_WEB_SESSION_COOKIE_NAME is invalid");
const codeServerUrl = normalizeHttpUrl("CODEX_WEB_CODE_SERVER_URL", process.env.CODEX_WEB_CODE_SERVER_URL);
const codeServerHealthUrl = normalizeHttpUrl("CODEX_WEB_CODE_SERVER_HEALTH_URL", process.env.CODEX_WEB_CODE_SERVER_HEALTH_URL)
  ?? defaultCodeServerHealthUrl(codeServerUrl);
if (!codeServerUrl && codeServerHealthUrl) throw new Error("CODEX_WEB_CODE_SERVER_HEALTH_URL requires CODEX_WEB_CODE_SERVER_URL");

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.CODEX_WEB_PORT ?? 7373),
  dataDir,
  codexHome: process.env.CODEX_WEB_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  databasePath: process.env.CODEX_WEB_DB_PATH ?? path.join(dataDir, "app.db"),
  logPath: path.join(dataDir, "logs", "server.log"),
  projectRoot: process.env.CODEX_WEB_PROJECT_ROOT ?? path.resolve(import.meta.dirname, "../../.."),
  openBrowser: process.env.CODEX_WEB_OPEN_BROWSER === "1",
  allowViteOrigin: process.env.CODEX_WEB_DEV_VITE_ORIGIN === "1",
  publicOrigins,
  passwordHash: process.env.CODEX_WEB_PASSWORD_HASH?.trim() || null,
  sessionCookieName,
  cookieSecure: process.env.CODEX_WEB_COOKIE_SECURE === "1" || publicOrigins.some((origin) => origin.startsWith("https://")),
  trustProxy: process.env.CODEX_WEB_TRUST_PROXY === "1",
  codeServerUrl,
  codeServerHealthUrl,
  codexCommand: process.env.CODEX_WEB_CODEX_BIN ?? "codex",
  version: "0.1.0",
};
