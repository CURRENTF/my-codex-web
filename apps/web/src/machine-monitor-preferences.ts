import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useMachineMonitorPreferences = create<{ enabled: boolean; setEnabled(enabled: boolean): void }>()(persist((set) => ({
  enabled: false,
  setEnabled: (enabled) => set({ enabled }),
}), { name: "codex-web:machine-monitor:v1", partialize: ({ enabled }) => ({ enabled }) }));
