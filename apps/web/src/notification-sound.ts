const COMPLETION_SOUND_URL = "/sounds/mokugyo-notification.mp3";
const COMPLETION_SOUND_VOLUME = 0.48;

let completionSound: HTMLAudioElement | null = null;
let playbackVersion = 0;

function getCompletionSound(): HTMLAudioElement | null {
  if (typeof Audio === "undefined") return null;
  if (completionSound) return completionSound;
  completionSound = new Audio(COMPLETION_SOUND_URL);
  completionSound.preload = "auto";
  completionSound.volume = COMPLETION_SOUND_VOLUME;
  return completionSound;
}

function resetSound(sound: HTMLAudioElement): void {
  sound.pause();
  sound.currentTime = 0;
  sound.muted = false;
  sound.volume = COMPLETION_SOUND_VOLUME;
}

export function preloadCompletionNotificationSound(): boolean {
  const sound = getCompletionSound();
  if (!sound) return false;
  try {
    sound.load();
    return true;
  } catch {
    return false;
  }
}

export function unlockCompletionNotificationSound(): boolean {
  const sound = getCompletionSound();
  if (!sound) return false;
  const version = ++playbackVersion;
  try {
    sound.muted = true;
    sound.currentTime = 0;
    const playback = sound.play();
    void playback.then(() => {
      if (version === playbackVersion) resetSound(sound);
    }).catch(() => {
      if (version === playbackVersion) resetSound(sound);
    });
    return true;
  } catch {
    if (version === playbackVersion) resetSound(sound);
    return false;
  }
}

export function playCompletionNotificationSound(): boolean {
  const sound = getCompletionSound();
  if (!sound) return false;
  ++playbackVersion;
  try {
    resetSound(sound);
    void sound.play().catch(() => { /* Browser autoplay policy may still block background audio. */ });
    return true;
  } catch {
    return false;
  }
}
