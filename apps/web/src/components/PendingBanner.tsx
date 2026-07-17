import { useEffect, useState } from "react";
import { ShieldWarning } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { api, newClientRequestId } from "../api";
import { useAppStore } from "../store";

export function PendingBanner({ threadId }: { threadId: string }) {
  const runtime = useAppStore((state) => state.runtimes[threadId]); const requests = useAppStore((state) => state.pendingRequests);
  const requestId = runtime?.pendingRequestIds[0]; const pending = requestId ? requests[requestId] : undefined;
  const [answers, setAnswers] = useState<Record<string, string | string[] | boolean | number>>({});
  useEffect(() => setAnswers({}), [requestId]);
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
  if (!requestId) return null;
  if (pending?.params?.type === "userInput") {
    const complete = pending.params.questions.every((question) => { const value = answers[question.id]; return typeof value === "string" && !!value.trim(); });
    return <div className="pending-banner pending-user-input"><div className="pending-heading"><ShieldWarning size={17} weight="fill" /><span>Codex 正在等待你的输入</span></div>
      <div className="pending-questions">{pending.params.questions.map((question) => {
        const rawAnswer = answers[question.id];
        const answer = typeof rawAnswer === "string" ? rawAnswer : "";
        const optionLabels = question.options?.map((option) => option.label) ?? [];
        const customValue = optionLabels.includes(answer) ? "" : answer;
        return <fieldset key={question.id}><legend><strong>{question.header}</strong><span>{question.question}</span></legend>
          {!!question.options?.length && <div className="pending-options">{question.options.map((option) => <button type="button" key={option.label} className={answers[question.id] === option.label ? "selected" : ""} title={option.description} onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}><strong>{option.label}</strong><small>{option.description}</small></button>)}</div>}
          {(question.isOther || !question.options?.length) && <input type={question.isSecret ? "password" : "text"} autoComplete="off" value={customValue} placeholder={question.isOther ? "其他答案" : "输入答案"} onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))} />}
        </fieldset>;
      })}</div>
      <div className="pending-actions"><button onClick={() => respond.mutate({ allow: false })} disabled={respond.isPending}>拒绝</button><button className="primary" onClick={() => respond.mutate({ allow: true, values: answers })} disabled={respond.isPending || !complete}>发送答案</button></div>
    </div>;
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
      <div className="pending-actions"><button onClick={() => respond.mutate({ allow: false })} disabled={respond.isPending}>拒绝</button><button className="primary" onClick={() => respond.mutate({ allow: true, values })} disabled={respond.isPending || !requiredComplete}>{pending.params.mode === "url" ? "已完成，继续" : "提交"}</button></div>
    </div>;
  }
  return <div className="pending-banner"><ShieldWarning size={17} weight="fill" /><span>Codex 正在等待额外确认</span><span className="pending-kind">{pending?.method}</span><button onClick={() => respond.mutate({ allow: true })} disabled={respond.isPending}>允许一次</button><button onClick={() => respond.mutate({ allow: false })} disabled={respond.isPending}>拒绝</button></div>;
}
