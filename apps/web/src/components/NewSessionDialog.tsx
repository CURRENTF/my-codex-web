import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, CheckCircle, Cpu, TerminalWindow, ArrowClockwise } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { BackendId, BackendOption } from "@codex-web/shared-types";
import { useComposerPreferences } from "../composer-preferences";
import { api } from "../api";

export function NewSessionDialog({ projectName, onClose, onCreate }: {
  projectName: string;
  onClose(): void;
  onCreate(backend: BackendId, models: BackendOption["models"]): Promise<void>;
}) {
  const [backend, setBackend] = useState<BackendId>(() => useComposerPreferences.getState().defaultBackend);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["backends"], queryFn: () => api<BackendOption[]>("/api/backends"), staleTime: 0 });
  const selected = query.data?.find((option) => option.id === backend);
  const create = async () => {
    if (!selected?.available || pending) return;
    setPending(true); setError(null);
    try { await onCreate(backend, selected.models); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "创建失败，请重试。"); }
    finally { setPending(false); }
  };
  return <Dialog.Root open onOpenChange={(open) => { if (!open && !pending) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content new-session-dialog">
        <div className="dialog-heading"><TerminalWindow size={19} /><Dialog.Title>新建对话</Dialog.Title></div>
        <Dialog.Description className="dialog-description">在 <strong>{projectName}</strong> 中选择本次对话的后端。</Dialog.Description>
        <fieldset className="backend-choices" disabled={pending}><legend>执行后端</legend>
          {(["codex", "pi"] as const).map((id) => {
            const option = query.data?.find((item) => item.id === id);
            return <label key={id} className={`backend-choice ${backend === id ? "selected" : ""}`}>
              <input type="radio" name="session-backend" aria-label={id === "pi" ? "pi" : "Codex"} value={id} checked={backend === id} onChange={() => { setBackend(id); setError(null); }} />
              <span className="backend-symbol" aria-hidden="true">{id === "codex" ? <TerminalWindow size={23} /> : <Cpu size={23} />}</span>
              <span className="backend-copy"><strong>{id === "codex" ? "Codex" : "pi"}</strong><small>{id === "codex" ? "使用 Codex 的模型与会话能力" : "使用 pi 配置的模型与工具"}</small></span>
              <span className="backend-choice-state">{query.isFetching ? "检查中" : option?.available ? "可用" : "未就绪"}</span>
              <CheckCircle size={19} weight={backend === id ? "fill" : "regular"} className="backend-check" aria-hidden="true" />
            </label>;
          })}
        </fieldset>
        <div className="backend-detail" aria-live="polite">
          {query.isError ? <p role="alert">无法获取后端状态：{query.error.message}</p> : selected?.message ? <p>{selected.message}</p> : <p>{backend === "pi" ? "pi 当前使用 Full Access，可读写文件并执行命令。" : "继承当前的新对话默认设置。"}</p>}
          <span>已有对话保持原后端；两种后端可同时使用。</span>
        </div>
        {error && <p className="dialog-error" role="alert">{error}</p>}
        <div className="dialog-actions backend-dialog-actions">
          <button className="button secondary backend-refresh" disabled={query.isFetching || pending} onClick={() => void query.refetch()} aria-label="刷新后端状态"><ArrowClockwise size={15} />刷新状态</button>
          <Dialog.Close asChild><button className="button secondary" disabled={pending}>取消</button></Dialog.Close>
          <button className="button primary" disabled={pending || query.isFetching || !selected?.available} onClick={() => void create()}>{pending ? "正在创建" : `使用 ${backend === "pi" ? "pi" : "Codex"} 创建`}<ArrowRight size={15} /></button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
