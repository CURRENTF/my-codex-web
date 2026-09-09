import { beforeEach, describe, expect, it } from "vitest";
import { composerWordCount, useComposerPreferences } from "../../apps/web/src/composer-preferences";

describe("composer preferences", () => {
  beforeEach(() => useComposerPreferences.setState({ longTextConfirmation: false, lastCreatedThreadId: null, lastCreatedModel: null }));
  it("counts Chinese characters, English words and mixed text without punctuation", () => {
    expect(composerWordCount("你好 world! Let's test，中文。")).toBe(7);
    expect(composerWordCount("中".repeat(50))).toBe(50);
    expect(composerWordCount("word ".repeat(51))).toBe(51);
    expect(composerWordCount("中文English中文")).toBe(5);
    expect(composerWordCount(" \n 🎉，！？")).toBe(0);
  });
  it("defaults protection off and follows only the last created session model", () => {
    const prefs = useComposerPreferences.getState();
    expect(prefs.longTextConfirmation).toBe(false);
    prefs.rememberCreatedSession("new", "model-a");
    prefs.rememberSessionModel("old", "model-b");
    expect(useComposerPreferences.getState().lastCreatedModel).toBe("model-a");
    prefs.rememberSessionModel("new", "model-c");
    expect(useComposerPreferences.getState().lastCreatedModel).toBe("model-c");
    prefs.rememberCreatedSession("next", "model-c");
    prefs.rememberSessionModel("new", "model-d");
    expect(useComposerPreferences.getState().lastCreatedModel).toBe("model-c");
  });
});
