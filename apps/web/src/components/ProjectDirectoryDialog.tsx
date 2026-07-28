import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowUp, CaretRight, Folder, FolderOpen, House, SpinnerGap, WarningCircle } from "@phosphor-icons/react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

interface DirectoryEntry {
  name: string;
  path: string;
  hidden: boolean;
  symbolicLink: boolean;
}

interface DirectoryListing {
  currentPath: string;
  parentPath: string | null;
  homePath: string;
  entries: DirectoryEntry[];
}

function directoryBreadcrumbs(directoryPath: string): Array<{ label: string; path: string }> {
  if (!directoryPath) return [];
  const normalized = directoryPath.replaceAll("\\", "/");
  const drive = /^[A-Za-z]:\//.exec(normalized)?.[0].slice(0, 2) ?? null;
  const root = drive ? `${drive}/` : "/";
  const parts = normalized.slice(root.length).split("/").filter(Boolean);
  return [
    { label: drive ?? "/", path: root },
    ...parts.map((label, index) => ({ label, path: `${root}${parts.slice(0, index + 1).join("/")}` })),
  ];
}

export function ProjectDirectoryDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onAdd(directoryPath: string): Promise<void>;
}) {
  const [requestedPath, setRequestedPath] = useState("");
  const [pathInput, setPathInput] = useState("");
  const [homePath, setHomePath] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState("");
  const listing = useQuery({
    queryKey: ["directory-browser", requestedPath || "~"],
    queryFn: ({ signal }) => api<DirectoryListing>(
      `/api/system/directories${requestedPath ? `?path=${encodeURIComponent(requestedPath)}` : ""}`,
      { signal },
    ),
    enabled: open,
    retry: false,
  });
  const breadcrumbs = useMemo(
    () => directoryBreadcrumbs(listing.data?.currentPath ?? requestedPath),
    [listing.data?.currentPath, requestedPath],
  );
  const parentPath = listing.data?.parentPath ?? breadcrumbs.at(-2)?.path ?? null;

  useEffect(() => {
    if (!open) return;
    setRequestedPath("");
    setPathInput("");
    setHomePath("");
    setAdding(false);
    setAddError("");
  }, [open]);

  useEffect(() => {
    if (!listing.data) return;
    setPathInput(listing.data.currentPath);
    setHomePath(listing.data.homePath);
  }, [listing.data]);

  const navigate = (directoryPath: string) => {
    const next = directoryPath.trim();
    if (!next) return;
    setAddError("");
    setRequestedPath(next);
  };
  const submitPath = (event: FormEvent) => {
    event.preventDefault();
    navigate(pathInput);
  };
  const addCurrentDirectory = async () => {
    const directoryPath = listing.data?.currentPath;
    if (!directoryPath || adding) return;
    setAdding(true);
    setAddError("");
    try {
      await onAdd(directoryPath);
      onOpenChange(false);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : "添加 Project 失败");
    } finally {
      setAdding(false);
    }
  };

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content project-directory-dialog" aria-describedby="project-directory-description">
        <div className="dialog-heading"><FolderOpen size={19} weight="fill" /><Dialog.Title>添加 Project</Dialog.Title></div>
        <Dialog.Description className="dialog-description" id="project-directory-description">
          浏览运行 Codex Web 的服务器文件夹。选中的目录会作为新 Project 的工作区。
        </Dialog.Description>

        <div className="directory-navigation">
          <button type="button" aria-label="前往主目录" title="主目录" disabled={!homePath} onClick={() => navigate(homePath)}><House size={15} /></button>
          <button type="button" aria-label="前往上级目录" title="上级目录" disabled={!parentPath} onClick={() => navigate(parentPath ?? "")}><ArrowUp size={15} /></button>
          <nav className="directory-breadcrumbs" aria-label="当前路径">
            {breadcrumbs.map((item, index) => <span key={item.path}>
              {index > 0 && <CaretRight size={10} />}
              <button type="button" onClick={() => navigate(item.path)}>{item.label}</button>
            </span>)}
          </nav>
        </div>

        <form className="directory-path-form" onSubmit={submitPath}>
          <label htmlFor="project-directory-path">文件夹路径</label>
          <div><input id="project-directory-path" value={pathInput} spellCheck={false} autoComplete="off" onChange={(event) => setPathInput(event.target.value)} /><button type="submit" className="button secondary" disabled={!pathInput.trim()}>前往</button></div>
        </form>

        <div className="directory-list" aria-live="polite">
          {listing.isLoading && <div className="directory-loading" aria-label="正在读取文件夹">
            <span /><span /><span /><span />
          </div>}
          {listing.isError && <div className="directory-state directory-error" role="alert"><WarningCircle size={22} weight="fill" /><strong>无法打开此文件夹</strong><span>{listing.error.message}</span></div>}
          {listing.data && listing.data.entries.length === 0 && <div className="directory-state"><FolderOpen size={24} /><strong>没有子文件夹</strong><span>可以直接添加当前文件夹。</span></div>}
          {listing.data?.entries.map((entry) => <button type="button" key={entry.path} className={`directory-entry ${entry.hidden ? "hidden-entry" : ""}`} onClick={() => navigate(entry.path)}>
            <Folder size={17} weight="fill" />
            <span>{entry.name}</span>
            {entry.symbolicLink && <small>链接</small>}
            <CaretRight size={13} />
          </button>)}
        </div>

        <div className="directory-selection">
          <Folder size={14} weight="fill" />
          <span><small>当前文件夹</small><code>{(listing.data?.currentPath ?? requestedPath) || "正在读取..."}</code></span>
        </div>
        {addError && <p className="dialog-error" role="alert">{addError}</p>}
        <div className="dialog-actions">
          <Dialog.Close asChild><button className="button secondary" type="button">取消</button></Dialog.Close>
          <button className="button primary" type="button" disabled={!listing.data || adding} onClick={() => void addCurrentDirectory()}>
            {adding ? <><SpinnerGap size={15} className="spinning" />正在添加</> : "添加此文件夹"}
          </button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export { directoryBreadcrumbs };
