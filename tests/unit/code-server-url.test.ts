import { describe, expect, it } from "vitest";
import { codeServerFileUrl, codeServerFolderUrl } from "../../apps/web/src/code-server-url";

describe("code-server URLs", () => {
  it("opens a folder through the configured code-server origin", () => {
    expect(codeServerFolderUrl("https://0513jtrc.beer:12334", "/home/haojitai/project a"))
      .toBe("https://0513jtrc.beer:12334/?folder=%2Fhome%2Fhaojitai%2Fproject+a");
  });

  it("opens a file and line in the current workspace", () => {
    expect(codeServerFileUrl("https://0513jtrc.beer:12334", "/home/haojitai/project/a b.ts", "/home/haojitai/project", 19))
      .toBe("https://0513jtrc.beer:12334/?folder=%2Fhome%2Fhaojitai%2Fproject&goto=%2Fhome%2Fhaojitai%2Fproject%2Fa+b.ts%3A19");
  });

  it("preserves a configured code-server base path", () => {
    expect(codeServerFileUrl("https://example.com/code", "/work/a.ts", "/work"))
      .toBe("https://example.com/code/?folder=%2Fwork&goto=%2Fwork%2Fa.ts");
  });
});
