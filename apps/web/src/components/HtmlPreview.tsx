export function HtmlPreview({ content }: { content: string }) {
  // The first base prevents relative URLs from resolving against the app/API.
  // Parse user HTML only inside the sandbox, never in the parent document.
  const document = `<!doctype html><base href="about:blank">\n${content}`;
  return <iframe key={document} className="code-html-preview" title="HTML 预览" sandbox="allow-scripts" referrerPolicy="no-referrer" src="/api/code/preview" onLoad={(event) => {
    const frame = event.currentTarget;
    // Send once, even if the preview subsequently navigates to another URL.
    if (frame.dataset.delivered) return;
    frame.dataset.delivered = "true";
    // The renderer has an opaque origin, so postMessage requires target "*".
    frame.contentWindow?.postMessage({ type: "codex-html-preview", content: document }, "*");
  }} />;
}
