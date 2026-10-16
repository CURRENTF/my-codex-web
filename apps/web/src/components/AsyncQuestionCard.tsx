import { useState } from "react";
import { ArrowDown } from "@phosphor-icons/react";
import type { AsyncUserInputQuestion } from "@codex-web/shared-types";
import { appendQuestionReply, questionReplyText } from "../async-question-reply";
import { useAppStore } from "../store";

export function AsyncQuestionCard({ threadId, itemId, questions, onReplyAdded }: { threadId: string; itemId: string; questions: AsyncUserInputQuestion[]; onReplyAdded?(): void }) {
  const [answers, setAnswers] = useState(() => questions.map((question) => question.options?.[0] ?? ""));
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const complete = questions.every((_, index) => !!answers[index]?.trim());
  const update = (index: number, answer: string, isCustom: boolean) => {
    setAnswers((current) => questions.map((_, i) => i === index ? answer : current[i] ?? ""));
    setCustom((current) => ({ ...current, [index]: isCustom }));
  };
  return <form className="async-question-card" aria-label="异步问题"
    onSubmit={(event) => {
      event.preventDefault();
      if (!complete || !threadId) return;
      const store = useAppStore.getState();
      store.setDraft(threadId, appendQuestionReply(store.drafts[threadId] ?? "", questionReplyText(questions, answers)));
      onReplyAdded?.();
    }}>
    <div className="async-question-fields">{questions.map((question, index) => {
      const name = `async-${threadId}-${itemId}-${index}`;
      return <fieldset key={index}>
        <legend>{question.title}</legend>
        {!!question.options?.length && <div className="question-options">{question.options.map((option, optionIndex) =>
          <label className={!custom[index] && answers[index] === option ? "question-option selected" : "question-option"} key={optionIndex}>
            <input type="radio" name={name} checked={!custom[index] && answers[index] === option} onChange={() => update(index, option, false)} />
            <span>{option}</span>
          </label>,
        )}</div>}
        <div className="question-custom"><label htmlFor={name}>{question.options?.length ? "或填写自己的答案" : "你的答案"}</label>
          <textarea id={name} rows={1} value={custom[index] || !question.options?.length ? answers[index] ?? "" : ""} onChange={(event) => update(index, event.target.value, true)} />
        </div>
      </fieldset>;
    })}</div>
    <button type="submit" className="async-question-add" disabled={!complete || !threadId} title="填入下方输入框，确认后发送"><ArrowDown size={14} />加入回复</button>
  </form>;
}
