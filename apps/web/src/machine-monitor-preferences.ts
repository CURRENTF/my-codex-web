import { create } from "zustand";
import { persist } from "zustand/middleware";

export const useMachineMonitorPreferences = create<{ enabled: boolean; position: { x: number; y: number } | null; setEnabled(enabled: boolean): void; setPosition(position: { x: number; y: number }): void }>()(persist((set) => ({
  enabled: false,
  position: null,
  setEnabled: (enabled) => set({ enabled }),
  setPosition: (position) => set({ position }),
}), { name: "codex-web:machine-monitor:v1", partialize: ({ enabled, position }) => ({ enabled, position }) }));
