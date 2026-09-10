import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ModelOption } from "@codex-web/shared-types";

interface ComposerPreferences {
  longTextConfirmation: boolean;
  defaultModel: string | null;
  defaultReasoning: string | null;
  setLongTextConfirmation(enabled: boolean): void;
  setSessionDefaults(model: string | null, reasoning: string | null): void;
}

export const useComposerPreferences = create<ComposerPreferences>()(persist((set) => ({
  longTextConfirmation: false,
  defaultModel: null,
  defaultReasoning: null,
  setLongTextConfirmation: (longTextConfirmation) => set({ longTextConfirmation }),
  setSessionDefaults: (defaultModel, defaultReasoning) => set({ defaultModel, defaultReasoning: defaultModel ? defaultReasoning : null }),
}), {
  name: "codex-web:composer-preferences:v1",
  version: 1,
  // The old last-created model was implicit history, not an explicit preference.
  migrate: (stored) => ({ longTextConfirmation: (stored as Partial<ComposerPreferences> | null)?.longTextConfirmation === true, defaultModel: null, defaultReasoning: null }),
  partialize: ({ longTextConfirmation, defaultModel, defaultReasoning }) => ({ longTextConfirmation, defaultModel, defaultReasoning }),
}));

export function sessionCreationDefaults(preferences: Pick<ComposerPreferences, "defaultModel" | "defaultReasoning">, models: ModelOption[]): { model?: string; reasoning?: string } {
  if (!preferences.defaultModel) return {};
  const model = models.find((item) => item.model === preferences.defaultModel || item.id === preferences.defaultModel);
  if (!model) throw new Error("默认模型当前不可用，请在设置中重新选择默认模型。");
  const reasoning = preferences.defaultReasoning ?? model.defaultReasoning;
  if (!model.supportedReasoning.some((item) => item.effort === reasoning)) throw new Error("默认 effort 当前不可用，请在设置中重新选择默认 effort。");
  return { model: model.model, reasoning };
}

// Count Han characters individually and other letter/number runs as words.
export function composerWordCount(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return han + words;
}
