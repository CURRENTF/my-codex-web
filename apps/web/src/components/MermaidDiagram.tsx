import { useEffect, useState } from "react";
import { renderMermaid } from "../mermaid-renderer";

interface DiagramResult {
  source: string;
  dark: boolean;
  svg?: string;
  failed?: boolean;
}

export function MermaidDiagram({ source }: { source: string }) {
  const [dark, setDark] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  const [result, setResult] = useState<DiagramResult | null>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Streaming replies may update on every token; wait for a brief pause.
    const timer = window.setTimeout(() => {
      void renderMermaid(source, dark).then(
        (svg) => { if (!cancelled) setResult({ source, dark, svg }); },
        () => { if (!cancelled) setResult({ source, dark, failed: true }); },
      );
    }, 200);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [source, dark]);

  const current = result?.source === source && result.dark === dark ? result : null;
  const code = <pre><code className="language-mermaid">{source}</code></pre>;
  return <figure className="mermaid-diagram" aria-busy={!current}>
    {current?.svg
      ? <>
        <div className="mermaid-svg" role="img" aria-label="Mermaid 图表" dangerouslySetInnerHTML={{ __html: current.svg }} />
        <details className="mermaid-source"><summary>源码</summary>{code}</details>
      </>
      : <>
        {current?.failed && <span className="mermaid-error" role="status">图表暂时无法渲染，显示源码</span>}
        {code}
      </>}
  </figure>;
}
