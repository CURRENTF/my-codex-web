import { useEffect, useId, useState } from "react";
import { CaretDown, CaretUp, ChatCircleText } from "@phosphor-icons/react";
import type { SessionTurn } from "@codex-web/shared-types";
import { AsyncQuestionCard } from "./AsyncQuestionCard";

export function AsyncQuestionDock({ threadId, turns }: { threadId: string; turns: SessionTurn[] }) {
  const [collapsed, setCollapsed] = useState(false);
  const contentId = useId();
  const questions = turns.flatMap((turn) => turn.items.flatMap((item) => item.type === "agentMessage" && item.delivery === "async" && item.questions?.length ? [item] : []));
  const latestId = questions.at(-1)?.id;
  useEffect(() => { setCollapsed(false); }, [latestId]);
  if (!questions.length) return null;
  return <section className="composer-wrap async-question-dock" aria-label="Codex 提问">
    <button type="button" className="async-question-dock-toggle" aria-expanded={!collapsed} aria-controls={contentId} onClick={() => setCollapsed(!collapsed)}>
      <ChatCircleText size={15} /><span>Codex 提问</span><small>{questions.length} 条</small>{collapsed ? <CaretUp size={14} /> : <CaretDown size={14} />}
    </button>
    <div className="async-question-dock-list" id={contentId} hidden={collapsed}>
      {questions.toReversed().map((item) => <AsyncQuestionCard key={item.id} threadId={threadId} itemId={item.id} questions={item.questions!} />)}
    </div>
  </section>;
}
