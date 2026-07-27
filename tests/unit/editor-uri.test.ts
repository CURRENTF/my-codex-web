import { describe, expect, it } from "vitest";
import { vscodeFileUri } from "../../apps/web/src/editor-uri";

describe("VS Code file URI", () => {
  it("encodes reserved and Unicode path characters without changing separators", () => {
    expect(vscodeFileUri("/tmp/a b/#work?/100%/中文")).toBe("vscode://file/tmp/a%20b/%23work%3F/100%25/%E4%B8%AD%E6%96%87");
  });

  it("targets a configured VS Code Remote SSH authority", () => {
    expect(vscodeFileUri("/home/haojitai/project/a b.ts", "ssh-remote+hitsz-8h100-hq-server"))
      .toBe("vscode://vscode-remote/ssh-remote+hitsz-8h100-hq-server/home/haojitai/project/a%20b.ts");
  });
});
