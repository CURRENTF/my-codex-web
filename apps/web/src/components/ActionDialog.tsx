import { useId, type FormEvent, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";

interface DialogFrameProps {
  open: boolean;
  title: string;
  description: ReactNode;
  icon: ReactNode;
  pending: boolean;
  tone?: "default" | "danger";
  onOpenChange(open: boolean): void;
  children: ReactNode;
}

function DialogFrame({ open, title, description, icon, pending, tone = "default", onOpenChange, children }: DialogFrameProps) {
  const descriptionId = useId();
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content action-dialog" aria-describedby={descriptionId}>
        <div className={`dialog-heading ${tone === "danger" ? "danger" : ""}`}>{icon}<Dialog.Title>{title}</Dialog.Title></div>
        <Dialog.Description className="dialog-description" id={descriptionId}>{description}</Dialog.Description>
        {children}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function TextInputDialog({ open, title, description, icon, label, value, maxLength, pending, error, submitLabel, onOpenChange, onValueChange, onSubmit }: {
  open: boolean;
  title: string;
  description: ReactNode;
  icon: ReactNode;
  label: string;
  value: string;
  maxLength?: number;
  pending: boolean;
  error?: string | null;
  submitLabel: string;
  onOpenChange(open: boolean): void;
  onValueChange(value: string): void;
  onSubmit(): void;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() && !pending) onSubmit();
  };
  return <DialogFrame open={open} title={title} description={description} icon={icon} pending={pending} onOpenChange={onOpenChange}>
    <form onSubmit={submit}>
      <label className="field-label">{label}<input autoFocus value={value} maxLength={maxLength} autoComplete="off" onChange={(event) => onValueChange(event.target.value)} /></label>
      {error && <p className="dialog-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <Dialog.Close asChild><button className="button secondary" type="button" disabled={pending}>取消</button></Dialog.Close>
        <button className="button primary" type="submit" disabled={!value.trim() || pending}>{pending ? "正在保存" : submitLabel}</button>
      </div>
    </form>
  </DialogFrame>;
}

export function ConfirmationDialog({ open, title, description, icon, pending, error, confirmLabel, onOpenChange, onConfirm }: {
  open: boolean;
  title: string;
  description: ReactNode;
  icon: ReactNode;
  pending: boolean;
  error?: string | null;
  confirmLabel: string;
  onOpenChange(open: boolean): void;
  onConfirm(): void;
}) {
  return <DialogFrame open={open} title={title} description={description} icon={icon} pending={pending} tone="danger" onOpenChange={onOpenChange}>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <Dialog.Close asChild><button className="button secondary" type="button" disabled={pending}>取消</button></Dialog.Close>
      <button className="button danger" type="button" disabled={pending} onClick={onConfirm}>{pending ? "正在移除" : confirmLabel}</button>
    </div>
  </DialogFrame>;
}
