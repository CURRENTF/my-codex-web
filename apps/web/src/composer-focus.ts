export const COMPOSER_FOCUS_RETRY_DELAYS = [0, 40, 160] as const;

export function shouldRestoreComposerFocus({
  hasActiveElement,
  activeIsTarget,
  activeIsOrigin,
  activeIsBody,
  activeIsDocumentElement,
  activeIsConnected,
}: {
  hasActiveElement: boolean;
  activeIsTarget: boolean;
  activeIsOrigin: boolean;
  activeIsBody: boolean;
  activeIsDocumentElement: boolean;
  activeIsConnected: boolean;
}): boolean {
  return !hasActiveElement
    || activeIsTarget
    || activeIsOrigin
    || activeIsBody
    || activeIsDocumentElement
    || !activeIsConnected;
}
