// The renderer has its own CSP so previews do not inherit the application's
// script-src 'self'. Sandbox the HTTP response too, including direct navigation.
export const htmlPreviewPolicy = [
  "default-src 'none'", "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:", "img-src data: blob: https:",
  "font-src data: https:", "media-src data: blob: https:",
  "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
  "base-uri about:", "form-action 'none'", "frame-ancestors 'self'",
  "sandbox allow-scripts",
].join("; ");

// Content stays in the browser. Only the embedding parent may supply it; the
// listener is removed before document.write runs any user-authored script.
export const htmlPreviewShell = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
function render(event) {
  if (event.source !== parent || parent === window || event.data?.type !== 'codex-html-preview' || typeof event.data.content !== 'string') return;
  removeEventListener('message', render);
  document.open();
  document.write(event.data.content);
  document.close();
}
addEventListener('message', render);
</script></body></html>`;
