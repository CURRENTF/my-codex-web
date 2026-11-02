import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppearancePreferences {
  liquidGlass: boolean;
  compactSessions: boolean;
  setLiquidGlass(enabled: boolean): void;
  setCompactSessions(enabled: boolean): void;
}

export const useAppearancePreferences = create<AppearancePreferences>()(persist((set) => ({
  liquidGlass: false,
  compactSessions: false,
  setLiquidGlass: (liquidGlass) => set({ liquidGlass }),
  setCompactSessions: (compactSessions) => set({ compactSessions }),
}), {
  name: "codex-web:appearance:v1",
  partialize: ({ liquidGlass, compactSessions }) => ({ liquidGlass, compactSessions }),
  merge: (stored, current) => ({
    ...current,
    liquidGlass: (stored as Partial<AppearancePreferences> | null)?.liquidGlass === true,
    compactSessions: (stored as Partial<AppearancePreferences> | null)?.compactSessions === true,
  }),
}));

// Apply to the document so Radix portals share the same appearance. Call before
// React mounts, after synchronous localStorage hydration, to avoid a theme flash.
export function initializeAppearance(): () => void {
  const apply = ({ liquidGlass }: AppearancePreferences) => {
    document.documentElement.dataset.appearance = liquidGlass ? "glass" : "classic";
  };
  apply(useAppearancePreferences.getState());
  return useAppearancePreferences.subscribe(apply);
}
