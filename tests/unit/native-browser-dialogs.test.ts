import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("application dialogs", () => {
  it("does not use browser-native prompt, confirm, or alert dialogs", () => {
    const sourceRoot = fileURLToPath(new URL("../../apps/web/src", import.meta.url));
    for (const path of sourceFiles(sourceRoot)) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/\b(?:window\.)?(?:prompt|confirm|alert)\s*\(/);
    }
  });
});
