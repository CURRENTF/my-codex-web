// Mermaid configuration is global. Keep configuration and rendering together
// when several messages render diagrams at the same time.
let renderQueue: Promise<unknown> = Promise.resolve();
let nextDiagramId = 0;

export function renderMermaid(source: string, dark: boolean): Promise<string> {
  const result = renderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "neutral",
      fontFamily: 'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      flowchart: { useMaxWidth: false, wrappingWidth: 320 },
    });
    const container = document.createElement("div");
    container.style.position = "absolute";
    container.style.visibility = "hidden";
    container.setAttribute("aria-hidden", "true");
    document.body.append(container);
    try {
      const { svg } = await mermaid.render(`message-mermaid-${++nextDiagramId}`, source, container);
      return svg;
    } finally {
      container.remove();
    }
  });
  renderQueue = result.catch(() => undefined);
  return result;
}

// Accept a standalone pasted flowchart as well as Markdown's explicit mermaid
// fences. Other messages and explicitly fenced code keep their Markdown meaning.
export function normalizeStandaloneMermaid(text: string): string {
  const trimmed = text.trim();
  if (!/^(?:flowchart|graph)\s+(?:TD|TB|BT|LR|RL)\s*;?\r?\n\s*\S/.test(trimmed)) return text;
  const fence = "~".repeat(Math.max(3, ...Array.from(trimmed.matchAll(/~+/g), (match) => match[0].length + 1)));
  return `${fence}mermaid\n${trimmed}\n${fence}`;
}
