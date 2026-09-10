import { beforeEach, describe, expect, it, vi } from "vitest";
import { composerWordCount, sessionCreationDefaults, useComposerPreferences } from "../../apps/web/src/composer-preferences";

vi.hoisted(() => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value), removeItem: (key: string) => items.delete(key) });
  vi.stubGlobal("window", { localStorage });
});

describe("composer preferences", () => {
  beforeEach(() => useComposerPreferences.setState({ longTextConfirmation: false, defaultModel: null, defaultReasoning: null }));
  it("counts Chinese characters, English words and mixed text without punctuation", () => {
    expect(composerWordCount("你好 world! Let's test，中文。")).toBe(7);
    expect(composerWordCount("中".repeat(50))).toBe(50);
    expect(composerWordCount("word ".repeat(51))).toBe(51);
    expect(composerWordCount("中文English中文")).toBe(5);
    expect(composerWordCount(" \n 🎉，！？")).toBe(0);
  });
  it("uses explicit model and effort independently of session changes", () => {
    const prefs = useComposerPreferences.getState();
    expect(prefs.longTextConfirmation).toBe(false);
    prefs.setSessionDefaults("model-a", "high");
    expect(sessionCreationDefaults(useComposerPreferences.getState(), models)).toEqual({ model: "model-a", reasoning: "high" });
    prefs.setLongTextConfirmation(true);
    expect(sessionCreationDefaults(useComposerPreferences.getState(), models)).toEqual({ model: "model-a", reasoning: "high" });
    prefs.setSessionDefaults(null, "high");
    expect(useComposerPreferences.getState().defaultReasoning).toBeNull();
    expect(sessionCreationDefaults(useComposerPreferences.getState(), models)).toEqual({});
  });
  it("resolves model default effort explicitly instead of inheriting project effort", () => {
    expect(sessionCreationDefaults({ defaultModel: "alias-a", defaultReasoning: null }, models)).toEqual({ model: "model-a", reasoning: "medium" });
  });
  it("reports unavailable saved options instead of silently using another model", () => {
    expect(() => sessionCreationDefaults({ defaultModel: "removed", defaultReasoning: "high" }, models)).toThrow("默认模型当前不可用");
    expect(() => sessionCreationDefaults({ defaultModel: "model-a", defaultReasoning: "ultra" }, models)).toThrow("默认 effort 当前不可用");
  });
  it("restores the explicit defaults from browser storage", async () => {
    localStorage.setItem("codex-web:composer-preferences:v1", JSON.stringify({ version: 1, state: { longTextConfirmation: false, defaultModel: "model-a", defaultReasoning: "high" } }));
    await useComposerPreferences.persist.rehydrate();
    expect(sessionCreationDefaults(useComposerPreferences.getState(), models)).toEqual({ model: "model-a", reasoning: "high" });
  });
  it("discards implicit model history during migration but preserves the text preference", () => {
    const migrate = useComposerPreferences.persist.getOptions().migrate!;
    expect(migrate({ longTextConfirmation: true, lastCreatedThreadId: "old", lastCreatedModel: "model-a" }, 0)).toEqual({ longTextConfirmation: true, defaultModel: null, defaultReasoning: null });
  });
});

const models = [{ id: "alias-a", model: "model-a", displayName: "Model A", description: "", isDefault: true, defaultReasoning: "medium", supportedReasoning: [{ effort: "medium" }, { effort: "high" }], serviceTiers: [], defaultServiceTier: null, inputModalities: ["text"] }];
