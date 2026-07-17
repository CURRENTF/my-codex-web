import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, CheckCircle, Clipboard, Code, FileCode, GitFork, TerminalWindow, Wrench, X, XCircle } from "@phosphor-icons/react";
import { Virtuoso } from "react-virtuoso";
import type { CodexItem, CodexTurn } from "../api";
import { commandOutputText } from "../command-output";
import { forkBoundaryForTurn } from "../fork-boundary";
import { useAppStore } from "../store";

function copy(text: string): void { void navigator.clipboard.writeText(text); }
function textFromUser(item: Extract<CodexItem, { type: "userMessage" }>): string { return item.content.map((part) => part.text ?? part.path ?? "").filter(Boolean).join("\n"); }
function diffStats(diff = ""): { additions: number; deletions: number } {
  let additions = 0; let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

function CommandCard({ item, liveDelta }: { item: Extract<CodexItem, { type: "commandExecution" }>; liveDelta?: string }) {
  const [open, setOpen] = useState(false); const output = commandOutputText(item.aggregatedOutput, liveDelta, open);
  return <div className="tool-card"><button className="tool-card-header" onClick={() => setOpen(!open)}><TerminalWindow size={16} /><span className="tool-title">{item.command}</span><span className={`tool-result ${item.exitCode === 0 ? "ok" : item.exitCode === null ? "running" : "bad"}`}>{item.exitCode === null ? item.status : `exit ${item.exitCode}`}</span></button>
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

function Item({ item, onOpenDiff }: { item: CodexItem; onOpenDiff(change: { path: string; kind: string; diff?: string }): void }) {
  const delta = useAppStore((state) => item.id ? state.deltas[item.id] : undefined);
  if (item.type === "userMessage") return <div className="user-message"><div>{textFromUser(item)}</div></div>;
  if (item.type === "agentMessage") return <article className="agent-message">{item.text}{delta ?? ""}</article>;
  if (item.type === "reasoning") return <details className="summary-card"><summary><Wrench size={15} />思考与执行摘要</summary><div className="summary-content">{[...item.summary, ...item.content, ...(delta ? [delta] : [])].map((text, index) => <p key={index}>{text}</p>)}</div></details>;
  if (item.type === "plan") return <details className="summary-card"><summary><CheckCircle size={15} />Plan</summary><pre className="plan-text">{item.text}{delta ?? ""}</pre></details>;
  if (item.type === "commandExecution") return <CommandCard item={item} liveDelta={delta} />;
  if (item.type === "fileChange") return <FileCard item={item} onOpenDiff={onOpenDiff} />;
  if (item.type === "mcpToolCall") return <ToolCard title={`${item.server} / ${item.tool}`} status={item.status} details={item.details} />;
  if (item.type === "genericToolCall") return <ToolCard title={item.title} status={item.status} details={item.details} />;
  return null;
}

function TurnBlock({ turn, previousTurnId, canFork, onFork, onSideChat, onOpenDiff }: { turn: CodexTurn; previousTurnId: string | null; canFork: boolean; onFork(turnId: string | null, position: "before" | "after", sourceTurnId: string): void; onSideChat(turnId: string): void; onOpenDiff(change: { path: string; kind: string; diff?: string }): void }) {
  const finalMessage = [...turn.items].reverse().find((item) => item.type === "agentMessage") as Extract<CodexItem, { type: "agentMessage" }> | undefined;
  const duration = turn.durationMs !== null ? `${Math.max(1, Math.round(turn.durationMs / 1_000))}s` : "";
  return <section className="turn-block">{turn.items.map((item, index) => <Item key={item.id ?? `${turn.id}-${index}`} item={item} onOpenDiff={onOpenDiff} />)}
    {turn.status !== "inProgress" && <footer className="turn-footer"><span className="turn-outcome">{turn.status === "completed" ? <Check size={13} /> : <XCircle size={13} />}已处理 {duration}</span>{finalMessage && <button onClick={() => copy(finalMessage.text)}><Clipboard size={13} />复制</button>}{canFork && <><button onClick={() => onFork(turn.id, "after", turn.id)}><GitFork size={13} />从此轮之后 Fork</button><button onClick={() => onFork(previousTurnId, "before", turn.id)}><GitFork size={13} />从此问题之前 Fork</button><button onClick={() => onSideChat(turn.id)}>从此处 Side Chat</button></>}</footer>}
  </section>;
}

export function Timeline({ turns, canFork = true, onFork, onSideChat }: { turns: CodexTurn[]; canFork?: boolean; onFork(turnId: string | null, position: "before" | "after", sourceTurnId: string): void; onSideChat(turnId: string): void }) {
  const staticTimeline = useRef<HTMLDivElement>(null);
  const [selectedDiff, setSelectedDiff] = useState<{ path: string; kind: string; diff?: string } | null>(null);
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
  if (!turns.length) return <div className="timeline-empty"><div className="empty-mark"><TerminalWindow size={26} /></div><h2>准备开始</h2><p>描述要在这个 Project 中完成的任务。</p></div>;
  const timeline = turns.length <= 40
    ? <div ref={staticTimeline} className="timeline timeline-static">{turns.map((turn, index) => { const boundary = forkBoundaryForTurn(turns, index); return <TurnBlock key={turn.id} turn={turn} previousTurnId={boundary.previousCompletedTurnId} canFork={canFork && boundary.canFork} onFork={onFork} onSideChat={onSideChat} onOpenDiff={setSelectedDiff} />; })}</div>
    : <Virtuoso className="timeline" data={turns} followOutput="smooth" initialTopMostItemIndex={Math.max(0, turns.length - 1)} itemContent={(index, turn) => { const boundary = forkBoundaryForTurn(turns, index); return <TurnBlock turn={turn} previousTurnId={boundary.previousCompletedTurnId} canFork={canFork && boundary.canFork} onFork={onFork} onSideChat={onSideChat} onOpenDiff={setSelectedDiff} />; }} />;
  return <div className={`timeline-shell ${selectedDiff ? "with-diff" : ""}`}>{timeline}{selectedDiff && <aside className="diff-panel"><header><div><strong>{selectedDiff.path}</strong><span>{selectedDiff.kind}</span></div><button onClick={() => setSelectedDiff(null)} aria-label="关闭 Diff"><X size={16} /></button></header><pre className="diff-output">{selectedDiff.diff || "没有可显示的 Diff"}</pre></aside>}</div>;
}
