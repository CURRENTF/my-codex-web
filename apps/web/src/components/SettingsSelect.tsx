import { Check } from "@phosphor-icons/react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";

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
  className = "",
}: {
  ariaLabel: string;
  menuLabel: string;
  value: string;
  options: readonly SettingsSelectOption[];
  onValueChange(value: string): void;
  disabled?: boolean;
  placeholder: string;
  variant: "model" | "reasoning";
  className?: string;
}) {
  const selected = options.find((option) => option.value === value);
  const selectedValue = value || EMPTY_VALUE;
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button
        type="button"
        className={`settings-select-trigger ${variant} ${className}`.trim()}
        aria-label={ariaLabel}
        title={selected?.description}
        disabled={disabled}
      >
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
        <DropdownMenu.Label className="settings-select-menu-label"><span>{menuLabel}</span><small>{options.length} 项</small></DropdownMenu.Label>
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
