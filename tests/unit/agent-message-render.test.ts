import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessage } from "../../apps/web/src/components/AgentMessage";

const require = createRequire(import.meta.url);

function packageVersion(packageJsonPath: string): string {
  return (JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version: string }).version;
}

function render(text: string, localImageUrls?: Record<string, string>, localPathUrls?: Record<string, string>, localPathKinds?: Record<string, "file" | "directory">) {
  return renderToStaticMarkup(createElement(AgentMessage, {
    text,
    codeServer: { url: "https://0513jtrc.beer:12334", state: "available", checkedAt: Date.now() },
    cwd: "/home/haojitai/project",
    localImageUrls,
    localPathUrls,
    localPathKinds,
  }));
}

describe("Agent message Markdown rendering", () => {
  it("preserves Markdown heading levels", () => {
    const html = render("# 一级标题\n\n## 二级标题\n\n### 三级标题\n\n#### 四级标题\n\n##### 五级标题\n\n###### 六级标题");
    expect(html).toContain("<h1>一级标题</h1>");
    expect(html).toContain("<h2>二级标题</h2>");
    expect(html).toContain("<h3>三级标题</h3>");
    expect(html).toContain("<h4>四级标题</h4>");
    expect(html).toContain("<h5>五级标题</h5>");
    expect(html).toContain("<h6>六级标题</h6>");
  });

  it("preserves ordered, unordered, and nested list structure", () => {
    const html = render("- 一级\n  - 二级\n    1. 三级有序\n    2. 三级有序二\n- 一级二\n\n1. 有序一级\n2. 有序一级二");
    const compact = html.replace(/>\s+</g, "><").replace(/\s+(?=<)/g, "");
    expect(compact).toContain("<ul><li>一级<ul><li>二级<ol><li>三级有序</li><li>三级有序二</li></ol></li></ul></li><li>一级二</li></ul>");
    expect(compact).toContain("<ol><li>有序一级</li><li>有序一级二</li></ol>");
  });

  it("renders fenced Bash code and inline code", () => {
    const html = render("`sparse-vllm-20260727-h2o-chain-prefix-cache-merge-validation`.\n\n```bash\ngit merge --ff-only codex/chain-prefix-cache\n```");
    expect(html).toContain("<code>sparse-vllm-20260727-h2o-chain-prefix-cache-merge-validation</code>");
    expect(html).toContain('<pre><code class="language-bash">git merge --ff-only codex/chain-prefix-cache');
  });

  it("renders inline and display math with KaTeX", () => {
    const html = render("行内公式 $H_2O$。\n\n$$\n\\operatorname{score}(q,k)=\\frac{q^\\top k}{\\sqrt{d}}\n$$");
    expect(html).toContain("katex");
    expect(html).toContain("katex-display");
    expect(html).toContain("operatorname");
  });

  it("uses KaTeX CSS from the same version as the rehype renderer", () => {
    const webRequire = createRequire(new URL("../../apps/web/src/components/AgentMessage.tsx", import.meta.url));
    const cssPackage = webRequire.resolve("katex/package.json");
    const rehypeRequire = createRequire(require.resolve("rehype-katex"));
    const rendererPackage = rehypeRequire.resolve("katex/package.json");

    expect(packageVersion(cssPackage)).toBe(packageVersion(rendererPackage));
  });

  it("renders standalone bracketed LaTeX emitted without math delimiters", () => {
    const html = render("[ \\text{replay amplification}\n\\frac{\\text{所有请求的 input tokens 总和}} {\\text{该 session 实际新增的 token 总和}} ]");
    expect(html).toContain("katex-display");
    expect(html).toContain("replay amplification");
    expect(html).toContain("mfrac");
    expect(html).not.toContain("[ ");
  });

  it("renders standard LaTeX display delimiters stored by Codex", () => {
    const html = render("\\[\n\\text{replay amplification}\n=\n\\frac{\\text{所有请求的 input tokens 总和}}\n{\\text{该 session 实际新增的 token 总和}}\n\\]");
    expect(html).toContain("katex-display");
    expect(html).toContain("replay amplification");
    expect(html).toContain("mfrac");
  });

  it("does not render raw HTML from an agent message", () => {
    const html = render('<script>alert("owned")</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders Markdown images with lazy loading and no referrer", () => {
    const html = render("![实验结果](https://example.com/result.png)");
    expect(html).toContain('href="https://example.com/result.png"');
    expect(html).toContain('src="https://example.com/result.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("uses a server-issued URL for a local Markdown image while leaving external images unchanged", () => {
    const localPath = "/home/haojitai/output/result.png";
    const displayUrl = "/api/local-images/00000000-0000-4000-8000-000000000000/content";
    const html = render(`![local](${localPath})\n\n![external](https://example.com/result.png)`, { [localPath]: displayUrl });
    expect(html).toContain(`href="${displayUrl}"`);
    expect(html).toContain(`src="${displayUrl}"`);
    expect(html).not.toContain(`src="${localPath}"`);
    expect(html).toContain('src="https://example.com/result.png"');
  });

  it("opens a linked local image through its authenticated HTTP URL instead of code-server", () => {
    const localPath = "/home/haojitai/output/result.png";
    const pathUrl = "/api/local-paths/00000000-0000-4000-8000-000000000000/content";
    const html = render(`[打开图片](${localPath})\n\n[报告](/data2/report.md)`, undefined, { [localPath]: pathUrl });
    expect(html).toContain(`href="${pathUrl}"`);
    expect(html).toContain("https://0513jtrc.beer:12334/?folder=/home/haojitai/project&amp;payload=");
    expect(html).toContain("vscode-remote%3A%2F%2F0513jtrc.beer%3A12334%2Fdata2%2Freport.md");
  });

  it("opens a linked local directory as the code-server workspace instead of treating it as a file", () => {
    const directory = "/home/haojitai/projects/Sparse-vLLM/benchmark/analysis/deltakv";
    const html = render(`[分析目录](${directory})`, undefined, undefined, { [directory]: "directory" });
    expect(html).toContain("https://0513jtrc.beer:12334/?folder=/home/haojitai/projects/Sparse-vLLM/benchmark/analysis/deltakv");
    expect(html).not.toContain("openFile=");
  });

  it("preserves safe external links, remote file links, and directives", () => {
    const html = render('见 [报告](/data2/report.md) 与 [文档](https://example.com/docs)。\n\n::code-comment{title="[P1] 性能实验失败会被误判" body="失败会写成 FAILED/OOM 并正常退出。" file="/home/test/run_suite.py" start=1355 end=1369 priority=1 confidence=0.99}\n::git-push{cwd="/home/haojitai/project" branch="codex/h2o"}');
    expect(html).toContain("https://0513jtrc.beer:12334/?folder=/home/haojitai/project&amp;payload=");
    expect(html).toContain("vscode-remote%3A%2F%2F0513jtrc.beer%3A12334%2Fdata2%2Freport.md");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain("P1 高优先级");
    expect(html).toContain("置信度 99%");
    expect(html).toContain("/home/test/run_suite.py:1355-1369");
    expect(html).toContain("vscode-remote%3A%2F%2F0513jtrc.beer%3A12334%2Fhome%2Ftest%2Frun_suite.py%3A1355");
    expect(html).toContain("gotoLineMode%22%2C%22true");
    expect(html).toContain("已推送分支");
  });

  it("does not fall back to vscode links while code-server is unavailable", () => {
    const html = renderToStaticMarkup(createElement(AgentMessage, {
      text: "[报告](/data2/report.md)",
      codeServer: { url: "https://0513jtrc.beer:12334", state: "unavailable", checkedAt: Date.now() },
      cwd: "/home/haojitai/project",
    }));
    expect(html).not.toContain("href=");
    expect(html).not.toContain("vscode://");
    expect(html).toContain("code-server 当前不可用");
  });
});
