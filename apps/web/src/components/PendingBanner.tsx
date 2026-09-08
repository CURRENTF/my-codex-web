import { useState } from "react";
import { ChatCircleText, ShieldWarning } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import type { PendingRequestSummary } from "@codex-web/shared-types";
import { api, newClientRequestId } from "../api";
import { useAppStore } from "../store";

export function PendingBanner({ threadId }: { threadId: string }) {
  const runtime = useAppStore((state) => state.runtimes[threadId]); const requests = useAppStore((state) => state.pendingRequests);
  const ids = runtime?.pendingRequestIds ?? [];
  if (!ids.length) return null;
  return <div className="pending-stack" aria-label="待处理请求">{ids.map((id) =>
    <PendingRequestCard key={`${threadId}:${id}`} requestId={id} pending={requests[id]} />,
  )}</div>;
}

function PendingRequestCard({ requestId, pending }: { requestId: string; pending?: PendingRequestSummary }) {
  const [answers, setAnswers] = useState<Record<string, string | string[] | boolean | number>>({});
  const [customQuestions, setCustomQuestions] = useState<Record<string, boolean>>({});
  const respond = useMutation({ mutationFn: ({ allow, values = {} }: { allow: boolean; values?: Record<string, string | string[] | boolean | number> }) => api(`/api/pending-requests/${requestId}/respond`, {
    method: "POST",
    body: JSON.stringify({
      allow,
      answers: Object.fromEntries(Object.entries(values).flatMap(([id, value]) => {
        const encoded = Array.isArray(value) ? value : [String(value)];
        const nonEmpty = encoded.map((item) => item.trim()).filter(Boolean);
        return nonEmpty.length ? [[id, nonEmpty]] : [];
      })),
      clientRequestId: newClientRequestId(),
    }),
  }) });
  if (!pending) return <div className="pending-banner pending-loading" role="status" aria-busy="true">正在加载请求…</div>;
  const responseError = respond.isError
    ? <p className="pending-response-error" role="alert">响应未送达：{respond.error.message}。请重试。</p>
    : null;
  if (pending?.params?.type === "userInput") {
    const { questions, isBlocking } = pending.params;
    const complete = questions.length > 0 && questions.every((question) => {
      const value = answers[question.id];
      return typeof value === "string" && !!value.trim();
    });
    const submitting = respond.isPending || respond.isSuccess;
    return <form className="pending-banner pending-user-input question-card" aria-label="Codex 问题" aria-busy={submitting}
      onSubmit={(event) => { event.preventDefault(); if (complete && !submitting) respond.mutate({ allow: true, values: answers }); }}>
      <div className="pending-heading"><ChatCircleText size={18} /><span>{isBlocking === false ? "Codex 想听听你的意见" : "Codex 正在等待你的输入"}</span></div>
      <p className="question-hint">{isBlocking === false ? "你可以稍后回答，Codex 会继续处理其他工作。" : "回答后，Codex 将继续当前任务。"}</p>
      <div className="pending-questions">{questions.map((question, index) => {
        const rawAnswer = answers[question.id];
        const answer = typeof rawAnswer === "string" ? rawAnswer : "";
        const isCustom = customQuestions[question.id] === true;
        const customValue = isCustom ? answer : "";
        const inputId = `question-${requestId}-${index}`;
        return <fieldset key={question.id} disabled={submitting}>
          <legend>{question.header && <strong>{question.header}</strong>}<span>{question.question}</span></legend>
          {!!question.options?.length && <div className="question-options">{question.options.map((option) =>
            <label key={option.label} className={!isCustom && answer === option.label ? "question-option selected" : "question-option"}>
              <input type="radio" name={inputId} value={option.label} checked={!isCustom && answer === option.label}
                onChange={() => { setCustomQuestions((current) => ({ ...current, [question.id]: false })); setAnswers((current) => ({ ...current, [question.id]: option.label })); }} />
              <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </label>,
          )}</div>}
          {(isBlocking === false || question.isOther || !question.options?.length) && <div className="question-custom">
            <label htmlFor={inputId}>{question.options?.length ? "或填写自己的答案" : "你的答案"}</label>
            {question.isSecret
              ? <input id={inputId} type="password" autoComplete="off" value={customValue} onChange={(event) => { setCustomQuestions((current) => ({ ...current, [question.id]: true })); setAnswers((current) => ({ ...current, [question.id]: event.target.value })); }} />
              : <textarea id={inputId} rows={2} value={customValue} onChange={(event) => { setCustomQuestions((current) => ({ ...current, [question.id]: true })); setAnswers((current) => ({ ...current, [question.id]: event.target.value })); }} />}
          </div>}
        </fieldset>;
      })}</div>
      {!questions.length && <p role="alert">问题内容为空，请跳过此请求。</p>}
      {responseError}<div className="pending-actions"><button type="button" onClick={() => respond.mutate({ allow: false })} disabled={submitting}>跳过</button><button type="submit" className="primary" disabled={submitting || !complete}>{respond.isPending ? "正在发送…" : respond.isSuccess ? "已发送" : "发送答案"}</button></div>
    </form>;
  }
  if (pending?.params?.type === "elicitation") {
    const requiredComplete = pending.params.fields.every((field) => !field.required || (() => { const value = answers[field.id] ?? field.defaultValue; return Array.isArray(value) ? value.length > 0 : value !== null && value !== ""; })());
    const values = Object.fromEntries(pending.params.fields.map((field) => [field.id, answers[field.id] ?? field.defaultValue ?? ""]));
    return <div className="pending-banner pending-user-input"><div className="pending-heading"><ShieldWarning size={17} weight="fill" /><span>{pending.params.serverName} 正在请求输入</span></div><p className="pending-message">{pending.params.message}</p>
      {pending.params.mode === "url" && pending.params.url && <a className="pending-link" href={pending.params.url} target="_blank" rel="noreferrer">打开授权页面</a>}
      {pending.params.mode !== "url" && <div className="pending-questions">{pending.params.fields.map((field) => {
        const value = answers[field.id] ?? field.defaultValue;
        return <fieldset key={field.id}><legend><strong>{field.title}{field.required ? " *" : ""}</strong>{field.description && <span>{field.description}</span>}</legend>
          {field.valueType === "boolean" ? <label className="pending-checkbox"><input type="checkbox" checked={Boolean(value)} onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.checked }))} />启用</label>
            : field.valueType === "singleSelect" ? <select value={typeof value === "string" ? value : ""} onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))}><option value="">请选择</option>{field.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
              : field.valueType === "multiSelect" ? <div className="pending-options">{field.options?.map((option) => { const selected = Array.isArray(value) && value.includes(option.value); return <button type="button" key={option.value} className={selected ? "selected" : ""} onClick={() => setAnswers((current) => ({ ...current, [field.id]: selected ? (value as string[]).filter((item) => item !== option.value) : [...(Array.isArray(value) ? value : []), option.value] }))}>{option.label}</button>; })}</div>
                : <input type={field.valueType === "number" || field.valueType === "integer" ? "number" : "text"} step={field.valueType === "integer" ? 1 : undefined} value={typeof value === "string" || typeof value === "number" ? value : ""} onChange={(event) => setAnswers((current) => ({ ...current, [field.id]: event.target.value }))} />}
        </fieldset>;
      })}</div>}
      {responseError}<div className="pending-actions"><button onClick={() => respond.mutate({ allow: false })} disabled={respond.isPending}>拒绝</button><button className="primary" onClick={() => respond.mutate({ allow: true, values })} disabled={respond.isPending || !requiredComplete}>{pending.params.mode === "url" ? "已完成，继续" : "提交"}</button></div>
    </div>;
  }
  return <div className="pending-banner"><ShieldWarning size={17} weight="fill" /><span>Codex 正在等待额外确认</span><span className="pending-kind">{pending?.method}</span><button onClick={() => respond.mutate({ allow: true })} disabled={respond.isPending}>允许一次</button><button onClick={() => respond.mutate({ allow: false })} disabled={respond.isPending}>拒绝</button>{responseError}</div>;
}
