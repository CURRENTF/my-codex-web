import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUp, FileCode, FloppyDisk, Folder, ArrowClockwise } from "@phosphor-icons/react";
import { api, authenticateWebUi, bootstrap } from "../api";
import "../code-view.css";
const CodeEditor = lazy(() => import("./CodeEditor"));
type FileData = { path: string; content: string; version: string };
type Listing = { path: string; parent: string | null; truncated: boolean; entries: { name: string; path: string; directory: boolean }[] };

export default function CodeView() {
  const params = new URLSearchParams(window.location.search);
  const root = params.get("root") ?? "";
  const initialFile = params.get("file");
  const line = Math.max(1, Number(params.get("line")) || 1);
  const [ready, setReady] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [password, setPassword] = useState("");
  const [listing, setListing] = useState<Listing | null>(null);
  const [file, setFile] = useState<FileData | null>(null);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("");
  const [generation, setGeneration] = useState(0);
  const [pending, setPending] = useState<null | (() => void)>(null);
  const inFlight = useRef(false);
  const dirty = file !== null && content !== file.content;
  const query = (target: string) => new URLSearchParams({ root, path: target });
  const message = (reason: unknown) => reason instanceof Error ? reason.message : "操作失败，请重试。";
  async function directory(target: string) {
    const data = await api<Listing>(`/api/code/directory?${query(target)}`, { cache: "no-store" });
    setListing(data); setFilter("");
  }
  async function run(action: () => Promise<unknown>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(""); setStatus("");
    try { await action(); } catch (reason) { setError(message(reason)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function load(target: string) {
    const data = await api<FileData>(`/api/code/file?${query(target)}`, { cache: "no-store" });
    setFile(data); setContent(data.content); setGeneration((value) => value + 1);
    return data;
  }
  const guard = (action: () => void) => { if (dirty) setPending(() => action); else action(); };
  const save = () => {
    if (!file || !dirty) return;
    const submitted = content;
    void run(async () => {
      const data = await api<FileData>("/api/code/file", { method: "PUT", body: JSON.stringify({ root, path: file.path, content: submitted, version: file.version }) });
      setFile(data); setStatus("已保存");
    });
  };
  useEffect(() => {
    void bootstrap().then(() => setReady(true)).catch((reason) => {
      if (reason?.status === 401) setNeedsLogin(true);
      else setError(message(reason));
    });
  }, []);
  useEffect(() => {
    if (!ready) return;
    void run(async () => {
      if (!root) throw new Error("请从 Project 或 Session 的 code 入口打开工作目录。");
      if (initialFile) {
        const data = await load(initialFile);
        await directory(data.path.slice(0, data.path.lastIndexOf("/")) || "/");
      } else await directory(root);
    });
  }, [ready]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);
  return <main className="code-view">
    <header className="code-view-header"><a className="header-button" href="/" onClick={(event) => { if (dirty) { event.preventDefault(); guard(() => { window.location.href = "/"; }); } }} aria-label="返回 Session"><ArrowLeft size={18} /></a><strong>Code View</strong><span className="code-root" title={root}>{root}</span></header>
    {needsLogin ? <form className="code-login" onSubmit={(event) => { event.preventDefault(); void run(async () => { await authenticateWebUi(password); await bootstrap(); setNeedsLogin(false); setReady(true); }); }}><h2>登录 Code View</h2><label>访问密码<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} /></label><button className="button primary" disabled={busy}>登录</button></form> :
    <div className="code-workspace"><aside className="code-files" aria-label="文件目录">
      <div className="code-directory-bar"><button className="header-button" disabled={busy || !listing?.parent} aria-label="上级目录" onClick={() => void run(() => directory(listing!.parent!))}><ArrowUp size={16} /></button><span title={listing?.path}>{listing?.path.split("/").pop() || "文件"}</span><button className="header-button" disabled={busy || !listing} aria-label="刷新目录" onClick={() => void run(() => directory(listing!.path))}><ArrowClockwise size={16} /></button></div>
      <label className="code-filter">筛选文件<input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="当前目录中的文件名" /></label>
      <div className="code-file-list">{!listing && busy ? <div className="code-loading">正在读取目录…</div> : listing?.entries.filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())).map((entry) => <button key={entry.path} className={`code-file-entry ${file?.path === entry.path ? "selected" : ""}`} disabled={busy} title={entry.name} onClick={() => entry.directory ? void run(() => directory(entry.path)) : guard(() => void run(() => load(entry.path)))}>{entry.directory ? <Folder size={16} /> : <FileCode size={16} />}<span>{entry.name}</span></button>)}{listing && !listing.entries.some((entry) => entry.name.toLowerCase().includes(filter.toLowerCase())) && <p className="code-empty">{filter ? "没有匹配的文件" : "此目录为空"}</p>}{listing?.truncated && <p>仅显示前 2000 项</p>}</div>
    </aside><section className="code-document" aria-label="文件编辑器"><div className="code-document-bar"><span title={file?.path}>{file ? file.path.split("/").pop() : "选择文件"}</span><span className="code-save-state" role="status">{dirty ? "未保存" : status}</span><button className="header-button" disabled={!file || busy} onClick={() => guard(() => void run(() => load(file!.path)))} aria-label="重新读取文件"><ArrowClockwise size={16} /></button><button className="button primary" disabled={!dirty || busy} onClick={save}><FloppyDisk size={16} />{busy && file ? "处理中" : "保存"}</button></div>
      {pending && <div className="code-discard" role="alert"><span>当前文件有未保存的修改。</span><button className="button secondary" onClick={() => setPending(null)}>继续编辑</button><button className="button danger" onClick={() => { const action = pending; setPending(null); action(); }}>放弃修改</button></div>}
      {file ? <Suspense fallback={<div className="code-loading">正在加载编辑器…</div>}><CodeEditor key={generation} content={file.content} path={file.path} line={generation === 1 ? line : 1} onChange={setContent} onSave={save} /></Suspense> : <div className="code-empty-state"><FileCode size={32} /><h2>打开文件，直接修改</h2><p>从左侧选择文本文件。</p><span>⌘ / Ctrl + S 保存，⌘ / Ctrl + F 查找</span></div>}
      <footer className="code-document-footer"><span title={file?.path}>{file ? file.path : "UTF-8 文本文件，最大 1 MiB"}</span><span>⌘ / Ctrl + S</span></footer>
    </section></div>}
    {error && <div className="code-error" role="alert">{error}<button className="header-button" onClick={() => setError("")}>关闭提示</button></div>}
  </main>;
}
