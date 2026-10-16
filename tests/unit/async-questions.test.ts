import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { projectAdapterEvent, projectThreadItem, projectTurn } from "@codex-web/codex-adapter";
import { appendQuestionReply, pendingAsyncQuestionItems, questionReplyText } from "../../apps/web/src/async-question-reply";
import { Timeline } from "../../apps/web/src/components/Timeline";
import { AsyncQuestionDock } from "../../apps/web/src/components/AsyncQuestionDock";
import { useAppStore } from "../../apps/web/src/store";

// Public thread/read shape observed on Codex 0.153.4; no pending RPC request.
const item = {
  type: "agentMessage", id: "call_questions", phase: "final_answer", delivery: "async",
  text: "Choose scope\n- Scope and ablation\n- Efficiency only",
  questions: [{ title: "Choose scope", options: ["Scope and ablation", "Efficiency only"] }, { title: "Model constraints?" }],
};

describe("persisted asynchronous questions", () => {
  beforeEach(() => useAppStore.setState({ drafts: {}, optimisticUserMessages: {}, pendingSubmissions: {}, queuedSubmissions: {}, queuedEffectiveSettings: {}, queuedTurnBarriers: {} }));
  const visible = (turns: Parameters<typeof pendingAsyncQuestionItems>[0]) => {
    const state = useAppStore.getState();
    return pendingAsyncQuestionItems(turns, [state.drafts.thread ?? "", ...(state.optimisticUserMessages.thread ?? []).map((message) => message.text)]);
  };
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
    expect(dock).toContain("加入回复");
    expect(dock).toContain("待回答");
    expect(dock).not.toContain("Codex 想听听你的意见");
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

  it("removes filled questions immediately, restores them if the draft is removed, and keeps other questions", () => {
    const turn = projectTurn({ id: "turn", status: "inProgress", items: [item, { ...item, id: "other", questions: [{ title: "Another question" }] }], error: null } as never);
    const reply = questionReplyText(item.questions, ["Efficiency only", "BF16"]);
    const store = useAppStore.getState();
    store.setDraft("thread", appendQuestionReply("Existing draft", reply));
    expect(visible([turn]).map((question) => question.id)).toEqual(["other"]);
    store.setDraft("thread", "Existing draft");
    expect(visible([turn]).map((question) => question.id)).toEqual(["other", item.id]);
  });

  it("stays hidden during send and acknowledgement, then reconstructs answered state from history after reload", () => {
    const turn = projectTurn({ id: "turn", status: "completed", items: [item], error: null } as never);
    const reply = questionReplyText(item.questions, ["Efficiency only", "BF16"]);
    const store = useAppStore.getState();
    store.setDraft("thread", reply);
    expect(visible([turn])).toEqual([]);
    store.beginSubmission("thread", reply, "reply-1");
    expect(visible([turn])).toEqual([]);
    store.acceptSubmission("thread");
    expect(useAppStore.getState().drafts.thread).toBeUndefined();
    expect(visible([turn])).toEqual([]);
    const replyTurn = projectTurn({ id: "reply-turn", status: "completed", items: [{ type: "userMessage", id: "reply-1", content: [{ type: "text", text: reply }] }], error: null } as never);
    useAppStore.setState({ drafts: {}, optimisticUserMessages: {}, pendingSubmissions: {} });
    expect(visible([turn, replyTurn])).toEqual([]);
    expect(renderToStaticMarkup(createElement(AsyncQuestionDock, { threadId: "thread", turns: [turn, replyTurn] }))).toBe("");
    expect(visible([turn])).toHaveLength(1);
  });

  it("restores the form when a failed submission is removed and its draft is cleared", () => {
    const turn = projectTurn({ id: "turn", status: "completed", items: [item], error: null } as never);
    const store = useAppStore.getState();
    const reply = questionReplyText(item.questions, ["Efficiency only", "BF16"]);
    store.setDraft("thread", reply);
    store.beginSubmission("thread", reply, "failed-reply");
    store.finishSubmission("thread", false);
    expect(visible([turn])).toEqual([]);
    store.setDraft("thread", "");
    expect(visible([turn])).toHaveLength(1);
  });

  it("hides queued replies but restores questions if that reply is removed from the queue", () => {
    const turn = projectTurn({ id: "turn", status: "inProgress", items: [item], error: null } as never);
    const store = useAppStore.getState();
    store.enqueueSubmission("thread", { kind: "message", text: questionReplyText(item.questions, ["Efficiency only", "BF16"]), skillNames: [], model: "test", reasoning: "high", serviceTier: null, accessMode: "fullAccess", clientRequestId: "queued-reply", clientUserMessageId: "queued-user", createdAt: 1 });
    expect(visible([turn])).toEqual([]);
    store.removeQueuedSubmission("thread", "queued-reply");
    expect(visible([turn])).toHaveLength(1);
  });

  it("handles multiple reply blocks and partially answered groups without hiding unrelated questions", () => {
    const turn = projectTurn({ id: "turn", status: "completed", items: [item, { ...item, id: "other", questions: [{ title: "Another question" }] }], error: null } as never);
    const partial = questionReplyText([item.questions[0]!], ["Efficiency only"]);
    const pending = pendingAsyncQuestionItems([turn], [partial]);
    expect(pending.find((entry) => entry.id === item.id)?.questions).toEqual([{ title: "Model constraints?" }]);
    const full = appendQuestionReply(questionReplyText(item.questions, ["Efficiency only", "BF16"]), questionReplyText([{ title: "Another question" }], ["Both"]));
    expect(pendingAsyncQuestionItems([turn], [full.replace(/\n/g, "\r\n")])).toEqual([]);
    expect(pendingAsyncQuestionItems([turn], [questionReplyText(item.questions, ["", ""])])).toHaveLength(2);
    expect(pendingAsyncQuestionItems([turn], ["I saw Choose scope and Model constraints?"])).toHaveLength(2);
  });

  it("does not apply an older answer to a later question with the same title", () => {
    const turn = projectTurn({ id: "turn", status: "inProgress", items: [item,
      { type: "userMessage", id: "answer", content: [{ type: "text", text: questionReplyText(item.questions, ["Efficiency only", "BF16"]) }] },
      { ...item, id: "new-question" },
    ], error: null } as never);
    expect(pendingAsyncQuestionItems([turn]).map((entry) => entry.id)).toEqual(["new-question"]);
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
