import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowSquareOut, CaretRight, Check, CheckCircle, Clipboard, Code, DownloadSimple, File as FileIcon, FileCode, GitFork, ImageSquare, SpinnerGap, TerminalWindow, Wrench, X, XCircle } from "@phosphor-icons/react";
import { Virtuoso } from "react-virtuoso";
import type { CodeServerStatus } from "@codex-web/shared-types";
import type { CodexItem, CodexTurn } from "../api";
import { commandOutputText, commandResultDisplay } from "../command-output";
import { forkBoundaryForTurn } from "../fork-boundary";
import { useAppStore, type OptimisticUserMessage } from "../store";
import { formatTurnCompletedAt, formatTurnDuration, groupTimelineItems, unconfirmedOptimisticUserMessages, type ActivityItem } from "../timeline-presentation";
import { AgentMessage } from "./AgentMessage";

function copy(text: string): void { void navigator.clipboard.writeText(text); }
function textFromUser(item: Extract<CodexItem, { type: "userMessage" }>): string { return item.content.map((part) => part.type === "skill" && part.name ? `$${part.name}` : part.text ?? "").filter(Boolean).join("\n"); }

interface DisplayAttachment { key: string; kind: "image" | "file"; name: string; url?: string; detail?: string }

function AttachmentList({ attachments }: { attachments: DisplayAttachment[] }) {
  if (!attachments.length) return null;
  const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.url);
  const files = attachments.filter((attachment) => attachment.kind === "file");
  return <>
    {images.length > 0 && <div className="message-image-grid">{images.map((attachment) => <a href={attachment.url} target="_blank" rel="noreferrer" key={attachment.key} title={`打开 ${attachment.name}`}><img src={attachment.url} alt={attachment.name} loading="lazy" referrerPolicy="no-referrer" /></a>)}</div>}
    {files.length > 0 && <div className="message-file-list">{files.map((attachment) => attachment.url
      ? <a href={attachment.url} download key={attachment.key}><FileIcon size={17} /><span><strong>{attachment.name}</strong>{attachment.detail && <small>{attachment.detail}</small>}</span><DownloadSimple size={15} /></a>
      : <span className="message-file" key={attachment.key} title={attachment.detail}><FileIcon size={17} /><strong>{attachment.name}</strong></span>)}</div>}
  </>;
}

function UserMessage({ item }: { item: Extract<CodexItem, { type: "userMessage" }> }) {
  const text = textFromUser(item);
  const attachments = item.content.flatMap<DisplayAttachment>((part, index) => {
    if (part.type === "image" || part.type === "localImage") {
      return [{ key: `${part.type}-${index}`, kind: "image", name: part.name ?? part.path?.split("/").at(-1) ?? "图片", url: part.displayUrl ?? part.url }];
    }
    if (part.type === "mention" && part.path) {
      return [{ key: `mention-${index}`, kind: "file", name: part.name ?? part.path.split("/").at(-1) ?? "附件", url: part.downloadUrl }];
    }
    return [];
  });
  return <div className="user-message"><div className={attachments.length ? "message-with-attachments" : undefined}>{text && <span className="user-message-text">{text}</span>}<AttachmentList attachments={attachments} /></div></div>;
}
function diffStats(diff = ""): { additions: number; deletions: number } {
  let additions = 0; let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function CommandCard({ item, liveDelta, turnStatus }: { item: Extract<CodexItem, { type: "commandExecution" }>; liveDelta?: string; turnStatus: CodexTurn["status"] }) {
  const [open, setOpen] = useState(false); const output = commandOutputText(item.aggregatedOutput, liveDelta, open); const result = commandResultDisplay(item.status, item.exitCode, turnStatus);
  return <div className="tool-card"><button className="tool-card-header" onClick={() => setOpen(!open)}><TerminalWindow size={16} /><span className="tool-title">{item.command}</span><span className={`tool-result ${result.tone}`}>{result.label}</span></button>
    <div className="tool-subline"><code>{item.cwd}</code>{item.durationMs !== null && <span>{(item.durationMs / 1_000).toFixed(1)}s</span>}</div>
    {output && <pre className={`command-output ${open ? "" : "preview"}`}>{output}</pre>}
  </div>;
}

function FileCard({ item, onOpenDiff }: { item: Extract<CodexItem, { type: "fileChange" }>; onOpenDiff(change: { path: string; kind: string; diff?: string }): void }) {
  const total = item.changes.reduce((result, change) => { const stats = diffStats(change.diff); return { additions: result.additions + stats.additions, deletions: result.deletions + stats.deletions }; }, { additions: 0, deletions: 0 });
  return <div className="tool-card"><div className="tool-card-header static"><FileCode size={16} /><span className="tool-title">修改文件 {item.changes.length}</span><span className="tool-result ok"><b>+{total.additions}</b> <i>−{total.deletions}</i></span></div>
    <div className="file-list">{item.changes.map((change) => { const stats = diffStats(change.diff); return <button key={change.path} onClick={() => onOpenDiff(change)}><code>{change.path}</code><span>{change.kind}</span><small><b>+{stats.additions}</b> <i>−{stats.deletions}</i></small></button>; })}</div>
  </div>;
}

function ToolCard({ title, status, details, icon = <Code size={16} /> }: { title: string; status: string; details?: string; icon?: ReactNode }) {
  if (!details) return <div className="tool-card compact"><div className="tool-card-header static">{icon}<span className="tool-title">{title}</span><span className="tool-result">{status}</span></div></div>;
  return <details className="tool-card compact expandable"><summary className="tool-card-header">{icon}<span className="tool-title">{title}</span><span className="tool-result">{status}</span></summary><pre className="tool-details">{details}</pre></details>;
}

function ToolImage({ item }: { item: Extract<CodexItem, { type: "imageView" | "imageGeneration" }> }) {
  const path = item.type === "imageView" ? item.path : item.savedPath;
  const title = item.type === "imageView" ? "查看图片" : "生成图片";
  if (!item.displayUrl) return <ToolCard title={path ? `${title} / ${path}` : title} status={item.type === "imageView" ? "completed" : item.status} details={item.type === "imageGeneration" ? item.result : undefined} icon={<ImageSquare size={16} />} />;
  return <figure className="tool-image-card"><a href={item.displayUrl} target="_blank" rel="noreferrer"><img src={item.displayUrl} alt={path?.split("/").at(-1) ?? title} loading="lazy" /></a><figcaption><ImageSquare size={15} /><span><strong>{title}</strong>{path && <code title={path}>{path}</code>}</span><a href={item.displayUrl} target="_blank" rel="noreferrer" aria-label="打开原图"><ArrowSquareOut size={15} /></a></figcaption></figure>;
}

function Item({ item, turnStatus, onOpenDiff, codeServer, cwd, grouped = false }: { item: CodexItem; turnStatus: CodexTurn["status"]; onOpenDiff(change: { path: string; kind: string; diff?: string }): void; codeServer: CodeServerStatus; cwd: string; grouped?: boolean }) {
  const delta = useAppStore((state) => item.id ? state.deltas[item.id] : undefined);
  if (item.type === "userMessage") return <UserMessage item={item} />;
  if (item.type === "agentMessage") return <AgentMessage text={`${item.text}${delta ?? ""}`} codeServer={codeServer} cwd={cwd} localImageUrls={item.localImageUrls} />;
  if (item.type === "reasoning") {
    const content = <div className="summary-content">{[...item.summary, ...(delta ? [delta] : [])].map((text, index) => <p key={index}>{text}</p>)}</div>;
    if (grouped) return <section className="activity-reasoning"><div className="activity-reasoning-label"><Wrench size={14} />思考摘要</div>{content}</section>;
    return <details className="summary-card"><summary><Wrench size={15} />思考与执行摘要</summary>{content}</details>;
  }
  if (item.type === "plan") return <details className="summary-card"><summary><CheckCircle size={15} />Plan</summary><pre className="plan-text">{item.text}{delta ?? ""}</pre></details>;
  if (item.type === "commandExecution") return <CommandCard item={item} liveDelta={delta} turnStatus={turnStatus} />;
  if (item.type === "fileChange") return <FileCard item={item} onOpenDiff={onOpenDiff} />;
  if (item.type === "mcpToolCall") return <ToolCard title={`${item.server} / ${item.tool}`} status={item.status} details={item.details} />;
  if (item.type === "imageView" || item.type === "imageGeneration") return <ToolImage item={item} />;
  if (item.type === "genericToolCall") return <ToolCard title={item.title} status={item.status} details={item.details} />;
  return null;
}

function ActivityGroup({ items, turnStatus, onOpenDiff, codeServer, cwd }: { items: ActivityItem[]; turnStatus: CodexTurn["status"]; onOpenDiff(change: { path: string; kind: string; diff?: string }): void; codeServer: CodeServerStatus; cwd: string }) {
  return <details className="activity-group">
    <summary><CaretRight className="activity-caret" size={14} weight="bold" /><Wrench size={15} /><span className="activity-title">思考与执行</span><span className="activity-count">{items.length} 项</span></summary>
    <div className="activity-group-content">{items.map((item) => <Item key={item.id} item={item} turnStatus={turnStatus} onOpenDiff={onOpenDiff} codeServer={codeServer} cwd={cwd} grouped />)}</div>
  </details>;
}

const EMPTY_OPTIMISTIC_MESSAGES: OptimisticUserMessage[] = [];

function OptimisticMessages({ messages }: { messages: OptimisticUserMessage[] }) {
  if (!messages.length) return null;
  return <section className="turn-block optimistic-message-block" aria-live="polite">{messages.map((message) => {
    const label = message.state === "sending" ? "发送中" : message.state === "uncertain" ? "正在确认" : "排队中";
    return <div className="pending-user-message" data-state={message.state} data-client-user-message-id={message.clientUserMessageId} key={message.clientUserMessageId}>
      <div className={message.attachments?.length ? "message-with-attachments" : undefined}>{message.text && <span className="pending-user-text">{message.text}</span>}<AttachmentList attachments={(message.attachments ?? []).map((attachment) => ({ key: attachment.id, kind: attachment.kind, name: attachment.name, url: attachment.kind === "image" ? attachment.url : `${attachment.url}?download=1`, detail: `${Math.ceil(attachment.size / 1_024)} KiB` }))} /><span className="pending-user-status"><SpinnerGap className="spinning" size={12} />{label}</span></div>
    </div>;
  })}</section>;
}

function TurnBlock({ turn, previousTurnId, canFork, onFork, onSideChat, onOpenDiff, codeServer, cwd }: { turn: CodexTurn; previousTurnId: string | null; canFork: boolean; onFork(turnId: string | null, position: "before" | "after", sourceTurnId: string): void; onSideChat(turnId: string): void; onOpenDiff(change: { path: string; kind: string; diff?: string }): void; codeServer: CodeServerStatus; cwd: string }) {
  const finalMessage = [...turn.items].reverse().find((item) => item.type === "agentMessage") as Extract<CodexItem, { type: "agentMessage" }> | undefined;
  const duration = formatTurnDuration(turn.durationMs);
  const completedAt = formatTurnCompletedAt(turn.completedAt);
  const entries = groupTimelineItems(turn.items);
  return <section className="turn-block">{entries.map((entry, index) => entry.kind === "activity"
    ? <ActivityGroup key={`activity-${entry.items[0]?.id ?? index}`} items={entry.items} turnStatus={turn.status} onOpenDiff={onOpenDiff} codeServer={codeServer} cwd={cwd} />
    : <Item key={entry.item.id ?? `${turn.id}-${index}`} item={entry.item} turnStatus={turn.status} onOpenDiff={onOpenDiff} codeServer={codeServer} cwd={cwd} />)}
    {turn.status !== "inProgress" && <footer className="turn-footer"><span className="turn-outcome">{turn.status === "completed" ? <Check size={13} /> : <XCircle size={13} />}{duration ? `已处理 ${duration}` : "处理完成"}{completedAt && <span className="turn-completed-at">· 完成于 {completedAt}</span>}</span>{finalMessage && <button onClick={() => copy(finalMessage.text)}><Clipboard size={13} />复制</button>}{canFork && <><button onClick={() => onFork(turn.id, "after", turn.id)}><GitFork size={13} />从此轮之后 Fork</button><button onClick={() => onFork(previousTurnId, "before", turn.id)}><GitFork size={13} />从此问题之前 Fork</button><button onClick={() => onSideChat(turn.id)}>从此处 Side Chat</button></>}</footer>}
  </section>;
}

export function Timeline({ threadId, turns, canFork = true, codeServer, cwd, onFork, onSideChat }: { threadId: string; turns: CodexTurn[]; canFork?: boolean; codeServer: CodeServerStatus; cwd: string; onFork(turnId: string | null, position: "before" | "after", sourceTurnId: string): void; onSideChat(turnId: string): void }) {
  const staticTimeline = useRef<HTMLDivElement>(null);
  const [selectedDiff, setSelectedDiff] = useState<{ path: string; kind: string; diff?: string } | null>(null);
  const optimisticMessages = useAppStore((state) => state.optimisticUserMessages[threadId] ?? EMPTY_OPTIMISTIC_MESSAGES);
  const visibleOptimisticMessages = unconfirmedOptimisticUserMessages(turns, optimisticMessages);
  useEffect(() => {
    if (turns.length > 40 || !staticTimeline.current) return;
    const scroller = staticTimeline.current;
    let stickToBottom = true;
    const updateStickiness = () => { stickToBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160; };
    const follow = () => { if (stickToBottom) scroller.scrollTop = scroller.scrollHeight; };
    scroller.scrollTop = scroller.scrollHeight;
    scroller.addEventListener("scroll", updateStickiness, { passive: true });
    const observer = new MutationObserver(follow);
    observer.observe(scroller, { childList: true, subtree: true, characterData: true });
    return () => { observer.disconnect(); scroller.removeEventListener("scroll", updateStickiness); };
  }, [turns.length]);
  if (!turns.length && !visibleOptimisticMessages.length) return <div className="timeline-empty"><div className="empty-mark"><TerminalWindow size={26} /></div><h2>准备开始</h2><p>描述要在这个 Project 中完成的任务。</p></div>;
  const optimistic = <OptimisticMessages messages={visibleOptimisticMessages} />;
  const timeline = turns.length <= 40
    ? <div ref={staticTimeline} className="timeline timeline-static">{turns.map((turn, index) => { const boundary = forkBoundaryForTurn(turns, index); return <TurnBlock key={turn.id} turn={turn} previousTurnId={boundary.previousCompletedTurnId} canFork={canFork && boundary.canFork} onFork={onFork} onSideChat={onSideChat} onOpenDiff={setSelectedDiff} codeServer={codeServer} cwd={cwd} />; })}{optimistic}</div>
    : <Virtuoso className="timeline" data={turns} followOutput="smooth" initialTopMostItemIndex={Math.max(0, turns.length - 1)} components={{ Footer: () => optimistic }} itemContent={(index, turn) => { const boundary = forkBoundaryForTurn(turns, index); return <TurnBlock turn={turn} previousTurnId={boundary.previousCompletedTurnId} canFork={canFork && boundary.canFork} onFork={onFork} onSideChat={onSideChat} onOpenDiff={setSelectedDiff} codeServer={codeServer} cwd={cwd} />; }} />;
  return <div className={`timeline-shell ${selectedDiff ? "with-diff" : ""}`}>{timeline}{selectedDiff && <aside className="diff-panel"><header><div><strong>{selectedDiff.path}</strong><span>{selectedDiff.kind}</span></div><button onClick={() => setSelectedDiff(null)} aria-label="关闭 Diff"><X size={16} /></button></header><pre className="diff-output">{selectedDiff.diff || "没有可显示的 Diff"}</pre></aside>}</div>;
}
