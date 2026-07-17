import { describe, expect, it } from "vitest";
import { commandOutputText } from "../../apps/web/src/command-output";

describe("commandOutputText", () => {
  it("shows live command deltas before the completion item arrives", () => {
    expect(commandOutputText(null, "STEP_1\nSTEP_2\n", false)).toBe("STEP_1\nSTEP_2");
  });

  it("shows only the last three lines while collapsed", () => {
    expect(commandOutputText("1\n2\n3\n4\n5\n", undefined, false)).toBe("3\n4\n5");
  });

  it("shows the complete output while expanded", () => {
    const output = Array.from({ length: 20 }, (_, index) => `line-${index + 1}`).join("\n");
    expect(commandOutputText(output, undefined, true)).toBe(output);
  });

  it("does not duplicate a live delta already present in an updated item", () => {
    expect(commandOutputText("STEP_1\nSTEP_2\n", "STEP_2\n", true)).toBe("STEP_1\nSTEP_2");
  });
});
