import { ShieldCheck } from "@phosphor-icons/react";
import type { AccessMode } from "@codex-web/shared-types";
import { SettingsSelect } from "./SettingsSelect";

const accessOptions = [
  { value: "fullAccess", label: "Full Access" },
  { value: "workspaceWrite", label: "Workspace Write" },
  { value: "readOnly", label: "Read Only" },
] satisfies Array<{ value: AccessMode; label: string }>;

export function AccessModeSelect({ value, onValueChange, disabled, className, ariaLabel = "权限" }: {
  value: AccessMode;
  onValueChange(value: AccessMode): void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  return <SettingsSelect
    variant="access" className={className} ariaLabel={ariaLabel} menuLabel="选择权限"
    value={value} options={accessOptions} placeholder="权限" disabled={disabled}
    icon={<ShieldCheck size={16} weight={value === "fullAccess" ? "fill" : "regular"} />}
    onValueChange={(next) => onValueChange(next as AccessMode)}
  />;
}
