import { create } from "zustand";
import { persist } from "zustand/middleware";

interface AppearancePreferences {
  liquidGlass: boolean;
  setLiquidGlass(enabled: boolean): void;
}

export const useAppearancePreferences = create<AppearancePreferences>()(persist((set) => ({
  liquidGlass: false,
  setLiquidGlass: (liquidGlass) => set({ liquidGlass }),
}), {
  name: "codex-web:appearance:v1",
  partialize: ({ liquidGlass }) => ({ liquidGlass }),
  merge: (stored, current) => ({
    ...current,
    liquidGlass: (stored as Partial<AppearancePreferences> | null)?.liquidGlass === true,
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
