import { ShieldCheck } from "@phosphor-icons/react";
import type { AccessMode, BackendId } from "@codex-web/shared-types";
import { SettingsSelect } from "./SettingsSelect";

const accessOptions = [
  { value: "fullAccess", label: "Full Access" },
  { value: "workspaceWrite", label: "Workspace Write" },
  { value: "readOnly", label: "Read Only" },
] satisfies Array<{ value: AccessMode; label: string }>;

export function AccessModeSelect({ value, onValueChange, disabled, className, ariaLabel = "权限", backend = "codex", agyFullAccess = false, onAgyFullAccessChange }: {
  value: AccessMode;
  onValueChange(value: AccessMode): void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  backend?: BackendId;
  agyFullAccess?: boolean;
  onAgyFullAccessChange?(value: boolean): void;
}) {
  const options = backend === "codex" ? accessOptions : backend === "pi" ? [
    { value: "fullAccess", label: "Full Access", description: "pi 以 Full Access 执行，无工作区沙箱。" },
  ] : [
    { value: "acceptEdits", label: "Accept Edits", description: "自动接受文件编辑，命令遵循原生权限检查。" },
    { value: "fullAccess", label: "Full Access", description: "命令与文件操作无需逐次审批。" },
  ];
  const selected = backend === "agy" ? (agyFullAccess ? "fullAccess" : "acceptEdits") : backend === "pi" ? "fullAccess" : value;
  return <SettingsSelect
    variant="access" className={className} ariaLabel={ariaLabel} menuLabel="选择权限"
    value={selected} options={options} placeholder="权限" disabled={disabled}
    icon={<ShieldCheck size={16} weight={selected === "fullAccess" ? "fill" : "regular"} />}
    onValueChange={(next) => {
      if (backend === "codex") onValueChange(next as AccessMode);
      else if (backend === "agy") onAgyFullAccessChange?.(next === "fullAccess");
    }}
  />;
}
