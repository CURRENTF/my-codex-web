import { ArrowSquareOut, CheckCircle, FileCode, GitBranch, GitCommit, MagnifyingGlass, UploadSimple, WarningDiamond, type Icon } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import { normalizeLooseDisplayMath, parseAgentMessage, type CodeCommentBlock, type GitReceiptBlock } from "../agent-message-format";
import { vscodeFileUri } from "../editor-uri";

function MarkdownMessage({ text, vscodeRemoteAuthority }: { text: string; vscodeRemoteAuthority: string | null }) {
  return <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[rehypeKatex]}
    components={{
      a({ href, children }) {
        if (href?.startsWith("/")) {
          return <a className="agent-inline-link file" href={vscodeFileUri(href, vscodeRemoteAuthority)} title={href}><FileCode size={14} />{children}</a>;
        }
        if (href && /^https?:\/\//.test(href)) {
          return <a className="agent-inline-link external" href={href} target="_blank" rel="noreferrer"><ArrowSquareOut size={14} />{children}</a>;
        }
        return <span>{children}</span>;
      },
      img({ src, alt }) {
        if (!src) return null;
        return <a className="agent-image-link" href={src} target="_blank" rel="noreferrer"><img src={src} alt={alt ?? "回复中的图片"} loading="lazy" referrerPolicy="no-referrer" /></a>;
      },
    }}
  >{normalizeLooseDisplayMath(text)}</ReactMarkdown>;
}

function CodeCommentCard({ comment, vscodeRemoteAuthority }: { comment: CodeCommentBlock; vscodeRemoteAuthority: string | null }) {
  const priority = comment.priority === null ? null : Math.max(0, Math.trunc(comment.priority));
  const title = priority === null ? comment.title : comment.title.replace(new RegExp(`^\\[P${priority}\\]\\s*`, "i"), "");
  const line = comment.start === null ? "" : comment.end !== null && comment.end !== comment.start ? `${comment.start}-${comment.end}` : String(comment.start);
  const target = `${vscodeFileUri(comment.file, vscodeRemoteAuthority)}${comment.start === null ? "" : `:${Math.trunc(comment.start)}`}`;
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
        <a className="code-comment-location" href={target} title={comment.file}>
          <FileCode size={14} />
          <code>{comment.file}{line && `:${line}`}</code>
          <span>打开文件 <ArrowSquareOut size={13} /></span>
        </a>
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

export function AgentMessage({ text, vscodeRemoteAuthority = null }: { text: string; vscodeRemoteAuthority?: string | null }) {
  return <article className="agent-message">{parseAgentMessage(text).map((block, index) => {
    if (block.kind === "codeComment") return <CodeCommentCard key={index} comment={block} vscodeRemoteAuthority={vscodeRemoteAuthority} />;
    if (block.kind === "gitReceipt") return <GitReceipt key={index} receipt={block} />;
    return <div className="agent-message-text" key={index}><MarkdownMessage text={block.text} vscodeRemoteAuthority={vscodeRemoteAuthority} /></div>;
  })}</article>;
}
