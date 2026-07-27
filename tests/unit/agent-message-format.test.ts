import { describe, expect, it } from "vitest";
import { normalizeLooseDisplayMath, parseAgentMessage, parseInlineMessageLinks } from "../../apps/web/src/agent-message-format";

describe("Agent message Codex directives", () => {
  it("parses code comments with quoted text and numeric metadata", () => {
    const [block] = parseAgentMessage('::code-comment{title="[P1] 性能实验失败会被误判" body="失败会写成 FAILED/OOM 并正常退出。" file="/home/test/run_suite.py" start=1355 end=1369 priority=1 confidence=0.99}');
    expect(block).toEqual({
      kind: "codeComment",
      title: "[P1] 性能实验失败会被误判",
      body: "失败会写成 FAILED/OOM 并正常退出。",
      file: "/home/test/run_suite.py",
      start: 1355,
      end: 1369,
      priority: 1,
      confidence: 0.99,
    });
  });

  it("parses Git receipts and preserves surrounding prose", () => {
    expect(parseAgentMessage('完成。\n\n::git-stage{cwd="/home/test/project"}\n::git-commit{cwd="/home/test/project"}\n::git-create-branch{cwd="/home/test/project" branch="codex/h2o"}\n::git-push{cwd="/home/test/project" branch="codex/h2o"}\n')).toEqual([
      { kind: "text", text: "完成。" },
      { kind: "gitReceipt", action: "stage", cwd: "/home/test/project", branch: null, url: null, draft: null },
      { kind: "gitReceipt", action: "commit", cwd: "/home/test/project", branch: null, url: null, draft: null },
      { kind: "gitReceipt", action: "create-branch", cwd: "/home/test/project", branch: "codex/h2o", url: null, draft: null },
      { kind: "gitReceipt", action: "push", cwd: "/home/test/project", branch: "codex/h2o", url: null, draft: null },
    ]);
  });

  it("drops unsafe Git receipt URLs", () => {
    expect(parseAgentMessage('::git-create-pr{cwd="/tmp/project" url="javascript:alert(1)" isDraft=true}')).toEqual([
      { kind: "gitReceipt", action: "create-pr", cwd: "/tmp/project", branch: null, url: null, draft: true },
    ]);
  });

  it("does not parse directives inside code fences or malformed directives", () => {
    const fenced = '```text\n::git-stage{cwd="/tmp/project"}\n```';
    expect(parseAgentMessage(fenced)).toEqual([{ kind: "text", text: fenced }]);
    expect(parseAgentMessage('::code-comment{title="missing body"}')).toEqual([{ kind: "text", text: '::code-comment{title="missing body"}' }]);
    expect(parseAgentMessage('::git-unknown{cwd="/tmp/project"}')).toEqual([{ kind: "text", text: '::git-unknown{cwd="/tmp/project"}' }]);
  });

  it("recognizes only safe HTTP and absolute-file Markdown links", () => {
    expect(parseInlineMessageLinks('见 [报告](/data2/report.md) 与 [PR](https://example.com/pr)，忽略 [脚本](javascript:alert)。')).toEqual([
      { kind: "text", text: "见 " },
      { kind: "link", label: "报告", target: "/data2/report.md", localFile: true },
      { kind: "text", text: " 与 " },
      { kind: "link", label: "PR", target: "https://example.com/pr", localFile: false },
      { kind: "text", text: "，忽略 " },
      { kind: "text", text: "[脚本](javascript:alert)" },
      { kind: "text", text: "。" },
    ]);
  });

  it("normalizes standalone bracketed LaTeX without touching ordinary brackets or code", () => {
    expect(normalizeLooseDisplayMath("[ \\text{replay amplification}\n\\frac{\\text{所有请求的 input tokens 总和}} {\\text{该 session 实际新增的 token 总和}} ]")).toBe(
      "$$\n\\text{replay amplification}\n\\frac{\\text{所有请求的 input tokens 总和}} {\\text{该 session 实际新增的 token 总和}}\n$$",
    );
    expect(normalizeLooseDisplayMath("[普通说明]\n\n```text\n[ \\frac{a}{b} ]\n```")).toBe("[普通说明]\n\n```text\n[ \\frac{a}{b} ]\n```");
  });
});
