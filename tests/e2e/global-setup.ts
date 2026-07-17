import assert from "node:assert/strict";
import { realpathSync } from "node:fs";

export default async function verifyIsolatedE2eServer(): Promise<void> {
  const baseUrl = process.env.CODEX_WEB_E2E_RESOLVED_BASE_URL;
  const expectedHome = process.env.CODEX_WEB_E2E_EXPECTED_CODEX_HOME;
  assert.ok(baseUrl && expectedHome, "E2E isolation context was not initialized");
  const origin = new URL(baseUrl).origin;
  const health = await fetch(`${baseUrl}/api/health`, { headers: { origin } }).then(async (response) => {
    assert.equal(response.ok, true, `E2E health check failed: ${response.status}`);
    return response.json() as Promise<{ codexHome?: string }>;
  });
  assert.ok(health.codexHome, "E2E health response did not include codexHome");
  assert.equal(realpathSync.native(health.codexHome), expectedHome, "E2E server is not using the explicitly isolated CODEX_HOME");
}
