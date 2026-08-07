import { afterEach, describe, expect, it, vi } from "vitest";

class FakeAudio {
  static instances: FakeAudio[] = [];
  readonly src: string;
  preload = "";
  volume = 1;
  currentTime = 0;
  muted = false;
  load = vi.fn();
  pause = vi.fn();
  play = vi.fn(() => Promise.resolve());

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }
}

describe("completion notification sound", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    FakeAudio.instances = [];
  });

  it("uses the bundled Mokugyo recording for preload, unlock, and playback", async () => {
    vi.stubGlobal("Audio", FakeAudio);
    const sound = await import("../../apps/web/src/notification-sound");

    expect(sound.preloadCompletionNotificationSound()).toBe(true);
    expect(FakeAudio.instances).toHaveLength(1);
    const audio = FakeAudio.instances[0]!;
    expect(audio.src).toBe("/sounds/mokugyo-notification.mp3");
    expect(audio.preload).toBe("auto");
    expect(audio.load).toHaveBeenCalledOnce();

    expect(sound.unlockCompletionNotificationSound()).toBe(true);
    await Promise.resolve();
    expect(audio.play).toHaveBeenCalledOnce();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.muted).toBe(false);

    expect(sound.playCompletionNotificationSound()).toBe(true);
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(audio.currentTime).toBe(0);
    expect(audio.volume).toBeCloseTo(0.48);
  });

  it("fails quietly when HTML audio is unavailable", async () => {
    vi.stubGlobal("Audio", undefined);
    const sound = await import("../../apps/web/src/notification-sound");
    expect(sound.preloadCompletionNotificationSound()).toBe(false);
    expect(sound.unlockCompletionNotificationSound()).toBe(false);
    expect(sound.playCompletionNotificationSound()).toBe(false);
  });
});
