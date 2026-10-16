import { useEffect, useId, useState } from "react";
import { CaretDown, CaretUp, ChatCircleText } from "@phosphor-icons/react";
import type { SessionTurn } from "@codex-web/shared-types";
import { pendingAsyncQuestionItems } from "../async-question-reply";
import { useAppStore } from "../store";
import { AsyncQuestionCard } from "./AsyncQuestionCard";

export function AsyncQuestionDock({ threadId, turns, onReplyAdded }: { threadId: string; turns: SessionTurn[]; onReplyAdded?(): void }) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  const draft = useAppStore((state) => state.drafts[threadId] ?? "");
  const optimisticMessages = useAppStore((state) => state.optimisticUserMessages[threadId]);
  const questions = pendingAsyncQuestionItems(turns, [draft, ...(optimisticMessages ?? []).map((message) => message.text)]);
  const latestId = questions[0]?.id;
  const count = questions.reduce((total, item) => total + item.questions.length, 0);
  useEffect(() => { setCollapsed(false); }, [latestId]);
  if (!questions.length) return null;
  return <section className="composer-wrap async-question-dock" aria-label="Codex 提问">
    <button type="button" className="async-question-dock-toggle" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(!collapsed)}>
      <ChatCircleText size={16} /><span>待回答<small>{count}</small></span>{collapsed ? <CaretUp size={14} /> : <CaretDown size={14} />}
    </button>
    <div className="async-question-dock-list" id={contentId} hidden={collapsed}>
      {questions.map((item) => <AsyncQuestionCard key={`${item.id}:${JSON.stringify(item.questions)}`} threadId={threadId} itemId={item.id} questions={item.questions} onReplyAdded={onReplyAdded} />)}
    </div>
  </section>;
}
