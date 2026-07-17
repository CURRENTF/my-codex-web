import { describe, expect, it } from "vitest";
import { resizedSideChatWidth } from "../../apps/web/src/side-chat-layout.js";

describe("Side Chat layout", () => {
  it("resizes against the available Workspace width", () => {
    expect(resizedSideChatWidth(42, 80, 800)).toBe(52);
  });

  it("keeps saved widths inside the product limits", () => {
    expect(resizedSideChatWidth(42, 1_000, 800)).toBe(65);
    expect(resizedSideChatWidth(42, -1_000, 800)).toBe(28);
  });
});
