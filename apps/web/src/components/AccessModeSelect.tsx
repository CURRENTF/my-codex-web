import { ShieldCheck } from "@phosphor-icons/react";
import type { AccessMode, BackendId } from "@codex-web/shared-types";
import { SettingsSelect } from "./SettingsSelect";

const accessOptions = [
  { value: "fullAccess", label: "Full Access" },
  { value: "workspaceWrite", label: "Workspace Write" },
  { value: "readOnly", label: "Read Only" },
] satisfies Array<{ value: AccessMode; label: string }>;

export function AccessModeSelect({ value, onValueChange, disabled, className, ariaLabel = "权限", backend = "codex" }: {
  value: AccessMode;
  onValueChange(value: AccessMode): void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
  backend?: BackendId;
}) {
  const options = backend === "codex" ? accessOptions : [{ value: "fullAccess", label: "Full Access",
    description: backend === "pi" ? "pi 以 Full Access 执行，无工作区沙箱。" : "agy 以 Full Access 执行，命令与文件操作无需逐次审批。" }];
  return <SettingsSelect
    variant="access" className={className} ariaLabel={ariaLabel} menuLabel="选择权限"
    value={backend === "codex" ? value : "fullAccess"} options={options} placeholder="权限" disabled={disabled}
    icon={<ShieldCheck size={16} weight={value === "fullAccess" ? "fill" : "regular"} />}
    onValueChange={(next) => { if (backend === "codex") onValueChange(next as AccessMode); }}
  />;
}
