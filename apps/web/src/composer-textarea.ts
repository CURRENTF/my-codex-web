export const COMPOSER_TEXTAREA_MIN_HEIGHT = 64;
export const COMPOSER_TEXTAREA_MAX_VIEWPORT_RATIO = 0.5;

export function resizeComposerTextarea(
  element: HTMLTextAreaElement,
  viewportHeight = window.visualViewport?.height ?? window.innerHeight,
): void {
  element.style.height = "auto";
  const maxHeight = Math.max(COMPOSER_TEXTAREA_MIN_HEIGHT, Math.floor(viewportHeight * COMPOSER_TEXTAREA_MAX_VIEWPORT_RATIO));
  const contentHeight = element.scrollHeight;
  element.style.height = `${Math.min(contentHeight, maxHeight)}px`;
  element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}
