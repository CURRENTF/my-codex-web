import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { projectAdapterEvent, projectThreadItem, projectTurn } from "@codex-web/codex-adapter";
import { appendQuestionReply, questionReplyText } from "../../apps/web/src/async-question-reply";
import { Timeline } from "../../apps/web/src/components/Timeline";
import { AsyncQuestionDock } from "../../apps/web/src/components/AsyncQuestionDock";

// Public thread/read shape observed on Codex 0.153.4; no pending RPC request.
const item = {
  type: "agentMessage", id: "call_questions", phase: "final_answer", delivery: "async",
  text: "Choose scope\n- Scope and ablation\n- Efficiency only",
  questions: [{ title: "Choose scope", options: ["Scope and ablation", "Efficiency only"] }, { title: "Model constraints?" }],
};

describe("persisted asynchronous questions", () => {
  it("preserves questions through history and both live item notifications", () => {
    const expected = { ...item };
    expect(projectThreadItem(item as never)).toEqual(expected);
    for (const method of ["item/started", "item/completed"]) {
      expect(projectAdapterEvent({ method, params: { threadId: "thread", turnId: "turn", item } })).toMatchObject({ item: expected });
    }
  });

  it("keeps history readable and renders the answer form beside the composer without a pending request", () => {
    const turn = projectTurn({ id: "turn", status: "completed", items: [item], error: null } as never);
    const html = renderToStaticMarkup(createElement(Timeline, {
      threadId: "thread", turns: [turn], cwd: "/tmp", canFork: false,
      onFork: () => {}, onSideChat: () => {},
    }));
    expect(html).toContain("Choose scope");
    expect(html).not.toContain('aria-label="异步问题"');
    expect(html).not.toContain("textarea");
    const dock = renderToStaticMarkup(createElement(AsyncQuestionDock, { threadId: "thread", turns: [turn] }));
    expect(dock).toContain('aria-label="异步问题"');
    expect(dock).toContain('type="radio"');
    expect(dock).toContain('checked=""');
    expect(dock).toContain("填入输入框");
    expect(dock).toContain("Model constraints?");
    expect(dock).toContain('name="async-thread-call_questions-0"');
  });

  it("keeps multiple questions accessible with the newest first after more agent activity", () => {
    const turn = projectTurn({ id: "turn", status: "inProgress", items: [item, { ...item, id: "new", questions: [{ title: "Newest question" }] }, { type: "agentMessage", id: "later", text: "Continuing other work" }], error: null } as never);
    const dock = renderToStaticMarkup(createElement(AsyncQuestionDock, { threadId: "thread", turns: [turn] }));
    expect(dock.match(/aria-label="异步问题"/g)).toHaveLength(2);
    expect(dock.indexOf("Newest question")).toBeLessThan(dock.indexOf("Choose scope"));
    expect(dock).not.toContain("Continuing other work");
    expect(renderToStaticMarkup(createElement(AsyncQuestionDock, { threadId: "thread", turns: [] }))).toBe("");
  });

  it("preserves unrelated drafts and associates each answer with its question", () => {
    const reply = questionReplyText(item.questions, ["Efficiency only", "BF16"]);
    expect(reply).toContain("1. Choose scope\n回答：Efficiency only");
    expect(reply).toContain("2. Model constraints?\n回答：BF16");
    const draft = appendQuestionReply("Keep my existing work", reply);
    expect(draft.startsWith("Keep my existing work\n\n")).toBe(true);
    expect(appendQuestionReply(draft, reply)).toBe(draft);
  });

  it("keeps malformed and legacy agent messages readable as ordinary text", () => {
    expect(projectThreadItem({ ...item, questions: [null, { title: 5 }, { title: "" }] } as never)).toEqual({
      type: "agentMessage", id: item.id, text: item.text, phase: item.phase, delivery: "async",
    });
    expect(projectThreadItem({ type: "agentMessage", id: "old", text: "Plain reply" } as never)).toEqual({
      type: "agentMessage", id: "old", text: "Plain reply",
    });
  });
});
