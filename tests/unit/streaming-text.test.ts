import { describe, expect, it } from "vitest";
import { mergeStreamingText } from "@codex-web/shared-types";

describe("mergeStreamingText", () => {
  it.each([
    ["正在检查代码。", "正在检查", "正在检查代码。"],
    ["回复完成。\n", "回复完成。", "回复完成。\n"],
    ["正在检查", "正在检查代码。", "正在检查代码。"],
    ["hello world", "hello world", "hello world"],
    ["hello world", "world", "hello world"],
    ["hello wor", "world", "hello world"],
    ["hello ", "world", "hello world"],
    ["", "answer", "answer"],
    ["answer", "", "answer"],
  ])("merges %j and %j without duplicating cumulative text", (current, incoming, expected) => {
    expect(mergeStreamingText(current, incoming)).toBe(expected);
  });
});
