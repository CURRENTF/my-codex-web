import { useMemo, useState } from "react";
import { Check, CheckCircle, Clipboard, Code, FileCode, GitFork, TerminalWindow, Wrench, XCircle } from "@phosphor-icons/react";
import { Virtuoso } from "react-virtuoso";
import type { CodexItem, CodexTurn } from "../api";
import { useAppStore } from "../store";

function copy(text: string): void { void navigator.clipboard.writeText(text); }
function textFromUser(item: Extract<CodexItem, { type: "userMessage" }>): string { return item.content.map((part) => part.text ?? part.path ?? "").filter(Boolean).join("\n"); }
function lastLines(output: string | null, count = 6): string { return (output ?? "").trim().split("\n").slice(-count).join("\n"); }

function CommandCard({ item }: { item: Extract<CodexItem, { type: "commandExecution" }> }) {
  const [open, setOpen] = useState(false); const output = lastLines(item.aggregatedOutput);
  return <div className="tool-card"><button className="tool-card-header" onClick={() => setOpen(!open)}><TerminalWindow size={16} /><span className="tool-title">{item.command}</span><span className={`tool-result ${item.exitCode === 0 ? "ok" : item.exitCode === null ? "running" : "bad"}`}>{item.exitCode === null ? item.status : `exit ${item.exitCode}`}</span></button>
    <div className="tool-subline"><code>{item.cwd}</code>{item.durationMs !== null && <span>{(item.durationMs / 1_000).toFixed(1)}s</span>}</div>
    {open && output && <pre className="command-output">{output}</pre>}
  </div>;
}

function FileCard({ item }: { item: Extract<CodexItem, { type: "fileChange" }> }) {
  const [open, setOpen] = useState(false); const lines = item.changes.reduce((count, change) => count + (change.diff?.split("\n").length ?? 0), 0);
  return <div className="tool-card"><button className="tool-card-header" onClick={() => setOpen(!open)}><FileCode size={16} /><span className="tool-title">修改文件 {item.changes.length}</span><span className="tool-result ok">{lines} lines</span></button>
    <div className="file-list">{item.changes.map((change) => <div key={change.path}><code>{change.path}</code><span>{change.kind}</span></div>)}</div>
    {open && <div className="diff-stack">{item.changes.map((change) => <pre key={change.path} className="diff-output">{change.diff}</pre>)}</div>}
  </div>;
}

function Item({ item }: { item: CodexItem }) {
  const delta = useAppStore((state) => item.id ? state.deltas[item.id] : undefined);
  if (item.type === "userMessage") return <div className="user-message"><div>{textFromUser(item)}</div></div>;
  if (item.type === "agentMessage") return <article className="agent-message">{item.text}{delta ?? ""}</article>;
  if (item.type === "reasoning") return <details className="summary-card"><summary><Wrench size={15} />思考与执行摘要</summary><div className="summary-content">{[...item.summary, ...item.content].map((text, index) => <p key={index}>{text}</p>)}</div></details>;
  if (item.type === "plan") return <details className="summary-card"><summary><CheckCircle size={15} />Plan</summary><pre className="plan-text">{item.text}</pre></details>;
  if (item.type === "commandExecution") return <CommandCard item={item} />;
  if (item.type === "fileChange") return <FileCard item={item} />;
  if (item.type === "mcpToolCall") return <div className="tool-card compact"><div className="tool-card-header static"><Code size={16} /><span className="tool-title">{item.server} / {item.tool}</span><span className="tool-result">{item.status}</span></div></div>;
  return null;
}

function TurnBlock({ turn, previousTurnId, canFork, onFork, onSideChat }: { turn: CodexTurn; previousTurnId: string | null; canFork: boolean; onFork(turnId: string | null, position: "before" | "after"): void; onSideChat(turnId: string): void }) {
  const finalMessage = [...turn.items].reverse().find((item) => item.type === "agentMessage") as Extract<CodexItem, { type: "agentMessage" }> | undefined;
  const duration = turn.durationMs !== null ? `${Math.max(1, Math.round(turn.durationMs / 1_000))}s` : "";
  return <section className="turn-block">{turn.items.map((item, index) => <Item key={item.id ?? `${turn.id}-${index}`} item={item} />)}
    {turn.status !== "inProgress" && <footer className="turn-footer"><span className="turn-outcome">{turn.status === "completed" ? <Check size={13} /> : <XCircle size={13} />}已处理 {duration}</span>{finalMessage && <button onClick={() => copy(finalMessage.text)}><Clipboard size={13} />复制</button>}{canFork && <><button onClick={() => onFork(turn.id, "after")}><GitFork size={13} />从此轮之后 Fork</button><button onClick={() => onFork(previousTurnId, "before")}><GitFork size={13} />从此问题之前 Fork</button><button onClick={() => onSideChat(turn.id)}>从此处 Side Chat</button></>}</footer>}
  </section>;
}

export function Timeline({ turns, canFork = true, onFork, onSideChat }: { turns: CodexTurn[]; canFork?: boolean; onFork(turnId: string | null, position: "before" | "after"): void; onSideChat(turnId: string): void }) {
  const completed = useMemo(() => turns.filter((turn) => turn.status !== "inProgress"), [turns]);
  if (!turns.length) return <div className="timeline-empty"><div className="empty-mark"><TerminalWindow size={26} /></div><h2>准备开始</h2><p>描述要在这个 Project 中完成的任务。</p></div>;
  return <Virtuoso className="timeline" data={turns} followOutput="smooth" initialTopMostItemIndex={Math.max(0, turns.length - 1)} itemContent={(index, turn) => <TurnBlock turn={turn} previousTurnId={index > 0 ? completed[index - 1]?.id ?? null : null} canFork={canFork && turn.status !== "inProgress"} onFork={onFork} onSideChat={onSideChat} />} />;
}
