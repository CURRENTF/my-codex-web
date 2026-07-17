import { useEffect, useMemo, useState } from "react";
import { GearSix, ShieldCheck } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AccessMode, ModelOption, Project } from "@codex-web/shared-types";
import { api, newClientRequestId } from "../api";

export function ProjectSettingsDialog({ project, models, onClose }: { project: Project | null; models: ModelOption[]; onClose(): void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [accessMode, setAccessMode] = useState<AccessMode>("fullAccess");
  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setModel(project.defaultModel ?? "");
    setReasoning(project.defaultReasoning ?? "");
    setAccessMode(project.defaultAccessMode);
  }, [project]);
  const selectedModel = useMemo(() => models.find((item) => item.model === model || item.id === model), [model, models]);
  useEffect(() => {
    if (selectedModel && reasoning && !selectedModel.supportedReasoning.some((item) => item.effort === reasoning)) setReasoning(selectedModel.defaultReasoning);
  }, [reasoning, selectedModel]);
  const save = useMutation({
    mutationFn: () => api<Project>(`/api/projects/${project!.id}`, {
      method: "PATCH",
      body: JSON.stringify({
        name: name.trim(),
        defaultModel: model || null,
        defaultReasoning: reasoning || null,
        defaultAccessMode: accessMode,
        clientRequestId: newClientRequestId(),
      }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      onClose();
    },
  });
  return <Dialog.Root open={!!project} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content project-settings-dialog" aria-describedby="project-settings-description">
        <div className="dialog-heading"><GearSix size={18} weight="fill" /><Dialog.Title>Project 设置</Dialog.Title></div>
        <Dialog.Description className="dialog-description" id="project-settings-description">新 Session 默认使用这些设置。普通 Fork 优先继承父 Session 当前设置。</Dialog.Description>
        <label className="field-label">显示名称<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
        <div className="settings-grid">
          <label className="field-label">默认模型<select value={model} onChange={(event) => { const next = event.target.value; setModel(next); const option = models.find((item) => item.model === next || item.id === next); setReasoning(option?.defaultReasoning ?? ""); }}><option value="">App Server 默认</option>{models.map((item) => <option key={item.id} value={item.model}>{item.displayName}</option>)}</select></label>
          <label className="field-label">默认 Reasoning<select value={reasoning} onChange={(event) => setReasoning(event.target.value)}><option value="">模型默认</option>{selectedModel?.supportedReasoning.map((item) => <option key={item.effort} value={item.effort}>{item.effort}</option>)}</select></label>
        </div>
        <label className="field-label">默认权限<div className="access-settings-field"><ShieldCheck size={16} weight={accessMode === "fullAccess" ? "fill" : "regular"} /><select value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessMode)}><option value="fullAccess">Full Access</option><option value="workspaceWrite">Workspace Write</option><option value="readOnly">Read Only</option></select></div></label>
        {save.isError && <p className="dialog-error">{save.error.message}</p>}
        <div className="dialog-actions"><Dialog.Close asChild><button className="button secondary">取消</button></Dialog.Close><button className="button primary" disabled={!name.trim() || save.isPending} onClick={() => save.mutate()}>保存设置</button></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
