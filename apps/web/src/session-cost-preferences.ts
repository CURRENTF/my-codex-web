import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useSessionCostPreferences = create<{ enabled: boolean; setEnabled(enabled: boolean): void }>()(persist((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}), { name: "codex-web:session-cost:v1", partialize: ({ enabled }) => ({ enabled }) }));
