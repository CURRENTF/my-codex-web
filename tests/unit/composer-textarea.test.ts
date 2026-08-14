import { describe, expect, it } from "vitest";
import { resizeComposerTextarea } from "../../apps/web/src/composer-textarea.js";

function textarea(scrollHeight: number): HTMLTextAreaElement {
  return { scrollHeight, style: { height: "", overflowY: "" } } as HTMLTextAreaElement;
}

describe("Composer textarea auto sizing", () => {
  it("uses the content height while the prompt fits", () => {
    const element = textarea(164);
    resizeComposerTextarea(element, 800);
    expect(element.style.height).toBe("164px");
    expect(element.style.overflowY).toBe("hidden");
  });

  it("caps long prompts at half the viewport and scrolls internally", () => {
    const element = textarea(900);
    resizeComposerTextarea(element, 720);
    expect(element.style.height).toBe("360px");
    expect(element.style.overflowY).toBe("auto");
  });

  it("never caps below the compact Composer height", () => {
    const element = textarea(180);
    resizeComposerTextarea(element, 100);
    expect(element.style.height).toBe("64px");
    expect(element.style.overflowY).toBe("auto");
  });
});
