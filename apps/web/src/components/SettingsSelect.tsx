import { ArrowClockwise, Check } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { ReactNode } from "react";

const EMPTY_VALUE = "__codex_web_empty_setting__";

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  meta?: string;
}

export function SettingsSelect({
  ariaLabel,
  menuLabel,
  value,
  options,
  onValueChange,
  disabled = false,
  placeholder,
  variant,
  icon,
  className = "",
  onOpen,
  onRefresh,
  refreshing = false,
  error,
}: {
  ariaLabel: string;
  menuLabel: string;
  value: string;
  options: readonly SettingsSelectOption[];
  onValueChange(value: string): void;
  disabled?: boolean;
  placeholder: string;
  variant: "model" | "reasoning" | "access" | "status" | "standard";
  icon?: ReactNode;
  className?: string;
  onOpen?(): void;
  onRefresh?(): void;
  refreshing?: boolean;
  error?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const selectedValue = value || EMPTY_VALUE;
  return <DropdownMenu.Root onOpenChange={(open) => { if (open) onOpen?.(); }}>
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        className={`settings-select-trigger ${variant} ${className}`.trim()}
        aria-label={ariaLabel}
        data-tooltip={selected?.description || selected?.label}
        disabled={disabled}
      >
        {icon && <span className="settings-select-icon" aria-hidden="true">{icon}</span>}
        <span className="settings-select-value">{(selected?.label ?? value) || placeholder}</span>
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        className={`settings-select-menu ${variant}`}
        side="top"
        align="end"
        sideOffset={7}
        collisionPadding={8}
        loop
      >
        <div className="settings-select-menu-label"><DropdownMenu.Label>{menuLabel}</DropdownMenu.Label>{onRefresh ? <DropdownMenu.Item className="model-catalog-refresh" aria-label="刷新模型列表" disabled={refreshing} onSelect={(event) => { event.preventDefault(); onRefresh(); }}><ArrowClockwise size={14} className={refreshing ? "spinning" : undefined} /></DropdownMenu.Item> : <small>{options.length} 项</small>}</div>
        {error && <p className="settings-select-message" role="alert">{error}</p>}
        {!error && options.length === 0 && <p className="settings-select-message">{refreshing ? "正在获取模型…" : "暂无可用模型"}</p>}
        <DropdownMenu.RadioGroup value={selectedValue} onValueChange={(next) => onValueChange(next === EMPTY_VALUE ? "" : next)}>
          {options.map((option) => <DropdownMenu.RadioItem
            key={option.value || EMPTY_VALUE}
            className="settings-select-option"
            value={option.value || EMPTY_VALUE}
          >
            <span className="settings-select-check" aria-hidden="true"><DropdownMenu.ItemIndicator><Check size={12} weight="bold" /></DropdownMenu.ItemIndicator></span>
            <span className="settings-select-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            {option.meta && <span className="settings-select-option-meta">{option.meta}</span>}
          </DropdownMenu.RadioItem>)}
        </DropdownMenu.RadioGroup>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
