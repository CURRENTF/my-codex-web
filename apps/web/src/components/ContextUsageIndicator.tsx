import type { CSSProperties } from "react";
import type { ContextUsage } from "@codex-web/shared-types";

export type ContextUsageTone = "normal" | "warning" | "danger";

export interface ContextUsagePresentation {
  usedLabel: string;
  maxLabel: string | null;
  percent: number | null;
  progressPercent: number | null;
  tone: ContextUsageTone;
  accessibleLabel: string;
}

export function formatContextTokens(value: number): string {
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) {
    const thousands = value / 1_000;
    return `${thousands >= 100 ? Math.round(thousands) : thousands.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

export function presentContextUsage(usage: ContextUsage): ContextUsagePresentation {
  const usedLabel = formatContextTokens(usage.usedTokens);
  if (usage.maxTokens === null || usage.maxTokens <= 0) {
    return {
      usedLabel,
      maxLabel: null,
      percent: null,
      progressPercent: null,
      tone: "normal",
      accessibleLabel: `当前上下文已使用 ${usedLabel} tokens，模型窗口上限未知`,
    };
  }
  const percent = Math.round((usage.usedTokens / usage.maxTokens) * 100);
  const tone: ContextUsageTone = percent >= 90 ? "danger" : percent >= 75 ? "warning" : "normal";
  const maxLabel = formatContextTokens(usage.maxTokens);
  return {
    usedLabel,
    maxLabel,
    percent,
    progressPercent: Math.min(100, Math.max(0, percent)),
    tone,
    accessibleLabel: `当前上下文已使用 ${usedLabel} / ${maxLabel} tokens，${percent}%`,
  };
}

export function ContextUsageIndicator({ usage }: { usage?: ContextUsage }) {
  if (!usage) return null;
  const view = presentContextUsage(usage);
  const ringLabel = view.progressPercent === null ? "?" : view.percent !== null && view.percent > 99 ? "99+" : String(view.progressPercent);
  const progressProps = view.progressPercent === null ? {} : {
    role: "progressbar",
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": view.progressPercent,
  };
  const ringStyle = view.progressPercent === null ? undefined : { "--context-progress": `${view.progressPercent}%` } as CSSProperties;
  return <div className={`context-usage ${view.tone}`} title={view.accessibleLabel} aria-label={view.accessibleLabel} {...progressProps}>
    <span className="context-usage-ring" style={ringStyle} aria-hidden="true"><strong>{ringLabel}</strong></span>
  </div>;
}
