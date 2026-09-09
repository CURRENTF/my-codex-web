import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ComposerPreferences {
  longTextConfirmation: boolean;
  lastCreatedThreadId: string | null;
  lastCreatedModel: string | null;
  setLongTextConfirmation(enabled: boolean): void;
  rememberCreatedSession(threadId: string, model: string | null): void;
  rememberSessionModel(threadId: string, model: string): void;
}

export const useComposerPreferences = create<ComposerPreferences>()(persist((set) => ({
  longTextConfirmation: false,
  lastCreatedThreadId: null,
  lastCreatedModel: null,
  setLongTextConfirmation: (longTextConfirmation) => set({ longTextConfirmation }),
  rememberCreatedSession: (lastCreatedThreadId, lastCreatedModel) => set({ lastCreatedThreadId, lastCreatedModel }),
  rememberSessionModel: (threadId, model) => set((state) =>
    threadId === state.lastCreatedThreadId && model ? { lastCreatedModel: model } : {}),
}), { name: "codex-web:composer-preferences:v1" }));

// Count Han characters individually and other letter/number runs as words.
export function composerWordCount(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0;
  const words = text.replace(/\p{Script=Han}/gu, " ").match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}]+)*/gu)?.length ?? 0;
  return han + words;
}
