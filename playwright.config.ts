import { defineConfig } from "@playwright/test";
import path from "node:path";
import { requireIsolatedCodexHome } from "./scripts/isolated-codex-home";

const external = process.env.CODEX_WEB_E2E_EXTERNAL === "1";
const port = external ? undefined : 7374;
const baseURL = process.env.CODEX_WEB_E2E_BASE_URL ?? `http://127.0.0.1:${port ?? 7373}`;
const codexHome = requireIsolatedCodexHome(
  external ? process.env.CODEX_WEB_E2E_CODEX_HOME : process.env.CODEX_WEB_E2E_CODEX_HOME ?? path.resolve(".runtime/codex-home/e2e"),
  "CODEX_WEB_E2E_CODEX_HOME",
);
process.env.CODEX_WEB_E2E_EXPECTED_CODEX_HOME = codexHome;
process.env.CODEX_WEB_E2E_RESOLVED_BASE_URL = baseURL;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  globalSetup: "./tests/e2e/global-setup.ts",
  use: { baseURL, trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: external ? undefined : {
    command: "npm run start", url: `http://127.0.0.1:${port}/api/health`, reuseExistingServer: false, timeout: 60_000,
    env: {
      ...process.env,
      CODEX_WEB_PORT: String(port),
      CODEX_WEB_OPEN_BROWSER: "0",
      CODEX_WEB_DATA_DIR: path.resolve(`.runtime/e2e-data/${process.pid}`),
      CODEX_WEB_CODEX_HOME: codexHome,
    },
  },
});
