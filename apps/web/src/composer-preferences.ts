import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { BackendId, ModelOption } from "@codex-web/shared-types";

interface ModelDefaults { defaultModel: string | null; defaultReasoning: string | null }
type BackendDefaults = Partial<Record<Exclude<BackendId, "codex">, ModelDefaults>>;

interface ComposerPreferences {
  longTextConfirmation: boolean;
  showUserMessageRail: boolean;
  defaultBackend: BackendId;
  askBackendOnNewSession: boolean;
  setDefaultBackend(backend: BackendId): void;
  setAskBackendOnNewSession(enabled: boolean): void;
  defaultModel: string | null;
  defaultReasoning: string | null;
  backendDefaults: BackendDefaults;
  setBackendDefaults(backend: BackendId, model: string | null, reasoning: string | null): void;
  setLongTextConfirmation(enabled: boolean): void;
  setShowUserMessageRail(enabled: boolean): void;
  setSessionDefaults(model: string | null, reasoning: string | null): void;
}

export const useComposerPreferences = create<ComposerPreferences>()(persist((set) => ({
  longTextConfirmation: false,
  showUserMessageRail: true,
  defaultBackend: "codex",
  askBackendOnNewSession: false,
  setDefaultBackend: (defaultBackend) => set({ defaultBackend }),
  setAskBackendOnNewSession: (askBackendOnNewSession) => set({ askBackendOnNewSession }),
  defaultModel: null,
  defaultReasoning: null,
  backendDefaults: {},
  setBackendDefaults: (backend, model, reasoning) => set((state) => {
    const defaults = { defaultModel: model, defaultReasoning: model ? reasoning : null };
    return backend === "codex" ? defaults : { backendDefaults: { ...state.backendDefaults, [backend]: defaults } };
  }),
  setLongTextConfirmation: (longTextConfirmation) => set({ longTextConfirmation }),
  setShowUserMessageRail: (showUserMessageRail) => set({ showUserMessageRail }),
  setSessionDefaults: (defaultModel, defaultReasoning) => set({ defaultModel, defaultReasoning: defaultModel ? defaultReasoning : null }),
}), {
  name: "codex-web:composer-preferences:v1",
  version: 1,
  // The old last-created model was implicit history, not an explicit preference.
  migrate: (stored) => ({ longTextConfirmation: (stored as Partial<ComposerPreferences> | null)?.longTextConfirmation === true, showUserMessageRail: true, defaultBackend: "codex" as const, askBackendOnNewSession: false, defaultModel: null, defaultReasoning: null, backendDefaults: {} }),
  partialize: ({ longTextConfirmation, showUserMessageRail, defaultBackend, askBackendOnNewSession, defaultModel, defaultReasoning, backendDefaults }) => ({ longTextConfirmation, showUserMessageRail, defaultBackend, askBackendOnNewSession, defaultModel, defaultReasoning, backendDefaults }),
}));

export function modelDefaultsForBackend(preferences: ModelDefaults & { backendDefaults?: BackendDefaults }, backend: BackendId): ModelDefaults {
  return backend === "codex" ? preferences : preferences.backendDefaults?.[backend] ?? { defaultModel: null, defaultReasoning: null };
}

export function sessionCreationDefaults(preferences: ModelDefaults & { backendDefaults?: BackendDefaults }, models: ModelOption[], backend: BackendId = "codex"): { model?: string; reasoning?: string } {
  const defaults = modelDefaultsForBackend(preferences, backend);
  if (!defaults.defaultModel) return {};
  const model = models.find((item) => item.model === defaults.defaultModel || item.id === defaults.defaultModel);
  if (!model) throw new Error("默认模型当前不可用，请在设置中重新选择默认模型。");
  const reasoning = defaults.defaultReasoning ?? model.defaultReasoning;
  if (!model.supportedReasoning.some((item) => item.effort === reasoning)) throw new Error("默认 effort 当前不可用，请在设置中重新选择默认 effort。");
  return { model: model.model, reasoning };
}

// Count Han characters individually and other letter/number runs as words.
export function composerWordCount(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return han + words;
}
