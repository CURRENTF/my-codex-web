import { ArrowSquareOut, CheckCircle, FileCode, GitBranch, GitCommit, MagnifyingGlass, UploadSimple, WarningDiamond, type Icon } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import type { CodeServerStatus } from "@codex-web/shared-types";
import { normalizeLooseDisplayMath, parseAgentMessage, type CodeCommentBlock, type GitReceiptBlock } from "../agent-message-format";
import { codeServerFileUrl } from "../code-server-url";

const UNCONFIGURED_CODE_SERVER: CodeServerStatus = { url: null, state: "unconfigured", checkedAt: null };

function unavailableTitle(codeServer: CodeServerStatus): string {
  if (codeServer.state === "checking") return "正在检查 code-server";
  if (codeServer.state === "unconfigured") return "未配置 code-server";
  return "code-server 当前不可用";
}

function MarkdownMessage({ text, codeServer, cwd, localImageUrls }: { text: string; codeServer: CodeServerStatus; cwd: string; localImageUrls: Record<string, string> }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{
      a({ href, children }) {
        const localImageUrl = href ? localImageUrls[href] : undefined;
        if (localImageUrl) {
          return <a className="agent-inline-link external" href={localImageUrl} target="_blank" rel="noreferrer" title={href}><ArrowSquareOut size={14} />{children}</a>;
        }
        if (href?.startsWith("/")) {
          if (codeServer.state !== "available" || !codeServer.url) return <span className="agent-inline-link file unavailable" aria-disabled="true" title={`${href} · ${unavailableTitle(codeServer)}`}><FileCode size={14} />{children}</span>;
          return <a className="agent-inline-link file" href={codeServerFileUrl(codeServer.url, href, cwd)} target="_blank" rel="noreferrer" title={href}><FileCode size={14} />{children}</a>;
        }
        if (href && /^https?:\/\//.test(href)) {
          return <a className="agent-inline-link external" href={href} target="_blank" rel="noreferrer"><ArrowSquareOut size={14} />{children}</a>;
        }
        return <span>{children}</span>;
      },
      img({ src, alt }) {
        if (!src) return null;
        const displaySrc = localImageUrls[src] ?? src;
        return <a className="agent-image-link" href={displaySrc} target="_blank" rel="noreferrer"><img src={displaySrc} alt={alt ?? "回复中的图片"} loading="lazy" referrerPolicy="no-referrer" /></a>;
      },
    }}
  >{normalizeLooseDisplayMath(text)}</ReactMarkdown>;
}

function CodeCommentCard({ comment, codeServer, cwd }: { comment: CodeCommentBlock; codeServer: CodeServerStatus; cwd: string }) {
  const priority = comment.priority === null ? null : Math.max(0, Math.trunc(comment.priority));
  const title = priority === null ? comment.title : comment.title.replace(new RegExp(`^\\[P${priority}\\]\\s*`, "i"), "");
  const line = comment.start === null ? "" : comment.end !== null && comment.end !== comment.start ? `${comment.start}-${comment.end}` : String(comment.start);
  const target = codeServer.state === "available" && codeServer.url
    ? codeServerFileUrl(codeServer.url, comment.file, cwd, comment.start)
    : null;
  const severity = priority === null
    ? { code: "Review", label: "审查建议", icon: MagnifyingGlass }
    : {
        code: `P${priority}`,
        label: ({ 0: "阻断问题", 1: "高优先级", 2: "中优先级", 3: "低优先级" } as Record<number, string>)[priority] ?? "审查建议",
        icon: WarningDiamond,
      };
  const SeverityIcon = severity.icon;
  return <section className={`code-comment-card ${priority === null ? "" : `priority-${priority}`}`}>
    <aside className="code-comment-severity" aria-label={`${severity.code} ${severity.label}`}>
      <SeverityIcon size={18} weight={priority === null ? "regular" : "fill"} />
      <strong>{severity.code}</strong>
      <span>{severity.label}</span>
    </aside>
    <div className="code-comment-content">
      <header>
        <strong>{title}</strong>
        {comment.confidence !== null && <span className="code-comment-confidence">置信度 {Math.round(Math.min(1, Math.max(0, comment.confidence)) * 100)}%</span>}
      </header>
      <p>{comment.body}</p>
      <footer>
        {target ? <a className="code-comment-location" href={target} target="_blank" rel="noreferrer" title={comment.file}>
          <FileCode size={14} />
          <code>{comment.file}{line && `:${line}`}</code>
          <span>打开文件 <ArrowSquareOut size={13} /></span>
        </a> : <span className="code-comment-location unavailable" aria-disabled="true" title={unavailableTitle(codeServer)}>
          <FileCode size={14} />
          <code>{comment.file}{line && `:${line}`}</code>
          <span>{unavailableTitle(codeServer)}</span>
        </span>}
      </footer>
    </div>
  </section>;
}

const gitActions: Record<string, { label: string; icon: Icon }> = {
  stage: { label: "已暂存更改", icon: FileCode },
  commit: { label: "已创建提交", icon: GitCommit },
  push: { label: "已推送分支", icon: UploadSimple },
  "create-branch": { label: "已创建分支", icon: GitBranch },
  "create-pr": { label: "已创建 Pull Request", icon: GitBranch },
};

function GitReceipt({ receipt }: { receipt: GitReceiptBlock }) {
  const presentation = gitActions[receipt.action] ?? { label: `Git ${receipt.action}`, icon: CheckCircle };
  const ReceiptIcon = presentation.icon;
  const label = receipt.action === "create-pr" && receipt.draft ? "已创建草稿 Pull Request" : presentation.label;
  return <section className="git-receipt">
    <span className="git-receipt-icon"><ReceiptIcon size={16} weight="bold" /></span>
    <div><strong>{label}</strong><span>{receipt.branch && <code>{receipt.branch}</code>}{receipt.cwd && <code>{receipt.cwd}</code>}{receipt.url && <a href={receipt.url} target="_blank" rel="noreferrer"><ArrowSquareOut size={13} />打开</a>}</span></div>
  </section>;
}

export function AgentMessage({ text, codeServer = UNCONFIGURED_CODE_SERVER, cwd = "/", localImageUrls = {} }: { text: string; codeServer?: CodeServerStatus; cwd?: string; localImageUrls?: Record<string, string> }) {
  return <article className="agent-message">{parseAgentMessage(text).map((block, index) => {
    if (block.kind === "codeComment") return <CodeCommentCard key={index} comment={block} codeServer={codeServer} cwd={cwd} />;
    if (block.kind === "gitReceipt") return <GitReceipt key={index} receipt={block} />;
    return <div className="agent-message-text" key={index}><MarkdownMessage text={block.text} codeServer={codeServer} cwd={cwd} localImageUrls={localImageUrls} /></div>;
  })}</article>;
}
