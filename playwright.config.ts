import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:7373", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: process.env.CODEX_WEB_E2E_EXTERNAL === "1" ? undefined : {
    command: "npm run start", url: "http://127.0.0.1:7373/api/health", reuseExistingServer: true, timeout: 60_000,
    env: { ...process.env, CODEX_WEB_OPEN_BROWSER: "0" },
  },
});
