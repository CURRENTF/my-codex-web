import { describe, expect, it } from "vitest";
import type { SessionItem, SessionTurnError } from "@codex-web/shared-types";
import { groupTimelineItems } from "../../apps/web/src/timeline-presentation";

const items: SessionItem[] = [
  { type: "userMessage", id: "user", content: [{ type: "text", text: "start" }] },
  { type: "reasoning", id: "first", summary: ["first step"] },
  { type: "reasoning", id: "second", summary: ["second step"] },
  { type: "agentMessage", id: "reply", text: "done" },
];
const error: SessionTurnError = { afterItemId: "first", message: "Reconnecting... 1/5", code: "responseStreamDisconnected", httpStatusCode: null, additionalDetails: null, willRetry: true, occurredAt: 1000 };

describe("error placement and grouping", () => {
  it("inserts errors between activity items instead of moving them to the end of a turn", () => {
    const grouped = groupTimelineItems(items, [error, { ...error, message: "Reconnecting... 2/5", occurredAt: 2000 }]);
    expect(grouped.map((entry) => entry.kind)).toEqual(["item", "activity", "error", "activity", "item"]);
    expect(grouped[1]).toMatchObject({ items: [{ id: "first" }] });
    expect(grouped[2]).toMatchObject({ errors: [error, expect.objectContaining({ message: "Reconnecting... 2/5" })], positionKnown: true });
    expect(grouped[3]).toMatchObject({ items: [{ id: "second" }] });
  });

  it("keeps separate causes, HTTP statuses, and occurrences at different positions separate", () => {
    const grouped = groupTimelineItems(items, [error, { ...error, message: "Authentication failed" }, { ...error, httpStatusCode: 503 }, { ...error, afterItemId: "second" }]);
    expect(grouped.filter((entry) => entry.kind === "error")).toHaveLength(4);
  });

  it("distinguishes errors before the first item from missing or retired anchors", () => {
    const grouped = groupTimelineItems(items, [{ ...error, afterItemId: null }, { ...error, afterItemId: "retired" }, { ...error, afterItemId: undefined }]);
    expect(grouped[0]).toMatchObject({ kind: "error", positionKnown: true });
    expect(grouped.at(-1)).toMatchObject({ kind: "error", positionKnown: false, errors: [expect.anything(), expect.anything()] });
  });

  it("does not merge a different cause between two otherwise matching failures", () => {
    const grouped = groupTimelineItems(items, [error, { ...error, message: "Different cause" }, { ...error, message: "Reconnecting... 2/5" }]);
    expect(grouped.filter((entry) => entry.kind === "error")).toHaveLength(3);
  });
});
