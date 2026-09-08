import { createContext, useContext, useState } from "react";
import { ChatCircleText } from "@phosphor-icons/react";
import type { AsyncUserInputQuestion } from "@codex-web/shared-types";
import { appendQuestionReply, questionReplyText } from "../async-question-reply";
import { useAppStore } from "../store";

export const QuestionThreadContext = createContext("");

export function AsyncQuestionCard({ itemId, questions }: { itemId: string; questions: AsyncUserInputQuestion[] }) {
  const threadId = useContext(QuestionThreadContext);
  const [answers, setAnswers] = useState(() => questions.map((question) => question.options?.[0] ?? ""));
  const [custom, setCustom] = useState<Record<number, boolean>>({});
  const [added, setAdded] = useState(false);
  const complete = questions.every((_, index) => !!answers[index]?.trim());
  const update = (index: number, answer: string, isCustom: boolean) => {
    setAnswers((current) => questions.map((_, i) => i === index ? answer : current[i] ?? ""));
    setCustom((current) => ({ ...current, [index]: isCustom }));
    setAdded(false);
  };
  return <form className="pending-banner pending-user-input question-card async-question-card" aria-label="异步问题"
    onSubmit={(event) => {
      event.preventDefault();
      if (!complete || !threadId) return;
      const store = useAppStore.getState();
      store.setDraft(threadId, appendQuestionReply(store.drafts[threadId] ?? "", questionReplyText(questions, answers)));
      setAdded(true);
    }}>
    <div className="pending-heading"><ChatCircleText size={18} /><span>Codex 想听听你的意见</span></div>
    <p className="question-hint">可稍后回答。选择后填入输入框，再发送给 Codex。</p>
    <div className="pending-questions">{questions.map((question, index) => {
      const name = `async-${threadId}-${itemId}-${index}`;
      return <fieldset key={index}>
        <legend><span>{question.title}</span></legend>
        {!!question.options?.length && <div className="question-options">{question.options.map((option, optionIndex) =>
          <label className={!custom[index] && answers[index] === option ? "question-option selected" : "question-option"} key={optionIndex}>
            <input type="radio" name={name} checked={!custom[index] && answers[index] === option} onChange={() => update(index, option, false)} />
            <span>{option}</span>
          </label>,
        )}</div>}
        <div className="question-custom"><label htmlFor={name}>{question.options?.length ? "或填写自己的答案" : "你的答案"}</label>
          <textarea id={name} rows={2} value={custom[index] || !question.options?.length ? answers[index] ?? "" : ""} onChange={(event) => update(index, event.target.value, true)} />
        </div>
      </fieldset>;
    })}</div>
    {added && <p className="question-hint" role="status">答案已填入输入框，尚未发送。你可以继续编辑。</p>}
    <div className="pending-actions"><button type="submit" className="primary" disabled={!complete || !threadId || added}>{added ? "已填入输入框" : "填入输入框"}</button></div>
  </form>;
}
