import { homedir } from "node:os";
import path from "node:path";

const dataDir = process.env.CODEX_WEB_DATA_DIR ?? path.join(homedir(), ".codex-web");

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.CODEX_WEB_PORT ?? 7373),
  dataDir,
  codexHome: process.env.CODEX_WEB_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  databasePath: process.env.CODEX_WEB_DB_PATH ?? path.join(dataDir, "app.db"),
  logPath: path.join(dataDir, "logs", "server.log"),
  projectRoot: process.env.CODEX_WEB_PROJECT_ROOT ?? path.resolve(import.meta.dirname, "../../.."),
  openBrowser: process.env.CODEX_WEB_OPEN_BROWSER === "1",
  codexCommand: process.env.CODEX_WEB_CODEX_BIN ?? "codex",
  version: "0.1.0",
};
