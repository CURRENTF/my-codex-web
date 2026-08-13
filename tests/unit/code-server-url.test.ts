import { describe, expect, it } from "vitest";
import { codeServerFileUrl, codeServerFolderUrl } from "../../apps/web/src/code-server-url";

describe("code-server URLs", () => {
  it("opens a folder through the configured code-server origin", () => {
    expect(codeServerFolderUrl("https://0513jtrc.beer:12334", "/home/haojitai/project a"))
      .toBe("https://0513jtrc.beer:12334/?folder=/home/haojitai/project%20a");
  });

  it("opens a file and line with the VS Code Web startup parameters", () => {
    expect(codeServerFileUrl("https://0513jtrc.beer:12334", "/home/haojitai/project/a b.ts", "/home/haojitai/project", 19))
      .toBe("https://0513jtrc.beer:12334/?folder=/home/haojitai/project&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2F0513jtrc.beer%3A12334%2Fhome%2Fhaojitai%2Fproject%2Fa%2520b.ts%3A19%22%5D%2C%5B%22gotoLineMode%22%2C%22true%22%5D%5D");
  });

  it("preserves a configured code-server base path", () => {
    expect(codeServerFileUrl("https://example.com/code", "/work/a.ts", "/work"))
      .toBe("https://example.com/code/?folder=/work&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2Fexample.com%2Fwork%2Fa.ts%22%5D%5D");
  });

  it("encodes query delimiters without obscuring path separators", () => {
    expect(codeServerFileUrl("https://example.com/code", "/work/a#b?.ts", "/work/a & b"))
      .toBe("https://example.com/code/?folder=/work/a%20%26%20b&payload=%5B%5B%22openFile%22%2C%22vscode-remote%3A%2F%2Fexample.com%2Fwork%2Fa%2523b%253F.ts%22%5D%5D");
  });
});
