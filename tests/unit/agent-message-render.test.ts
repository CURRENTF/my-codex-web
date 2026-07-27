import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentMessage } from "../../apps/web/src/components/AgentMessage";

function render(text: string) {
  return renderToStaticMarkup(createElement(AgentMessage, {
    text,
    vscodeRemoteAuthority: "ssh-remote+hitsz-8h100-hq-server",
  }));
}

describe("Agent message Markdown rendering", () => {
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

  it("does not render raw HTML from an agent message", () => {
    const html = render('<script>alert("owned")</script><img src=x onerror=alert(1)>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("preserves safe external links, remote file links, and directives", () => {
    const html = render('见 [报告](/data2/report.md) 与 [文档](https://example.com/docs)。\n\n::code-comment{title="[P1] 性能实验失败会被误判" body="失败会写成 FAILED/OOM 并正常退出。" file="/home/test/run_suite.py" start=1355 end=1369 priority=1 confidence=0.99}\n::git-push{cwd="/home/haojitai/project" branch="codex/h2o"}');
    expect(html).toContain("vscode://vscode-remote/ssh-remote+hitsz-8h100-hq-server/data2/report.md");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain("P1 高优先级");
    expect(html).toContain("置信度 99%");
    expect(html).toContain("/home/test/run_suite.py:1355-1369");
    expect(html).toContain("已推送分支");
  });
});
