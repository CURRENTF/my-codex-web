import { create } from "zustand";
import type { UploadedAttachment } from "@codex-web/shared-types";
import { endpoints } from "./api";

export const MAX_ATTACHMENTS = 10;
interface AttachmentDraft {
  attachments: UploadedAttachment[];
  pending: { id: string; name: string }[];
  error: string | null;
}
export const emptyAttachmentDraft: AttachmentDraft = { attachments: [], pending: [], error: null };
const STORAGE_KEY = "codex-web:attachment-drafts:v1";

function readDrafts(): Record<string, AttachmentDraft> {
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).flatMap(([threadId, value]) => {
      if (!value || typeof value !== "object") return [];
      const draft = value as Partial<AttachmentDraft>;
      if (!Array.isArray(draft.attachments)) return [];
      const attachments = draft.attachments.filter((item): item is UploadedAttachment => item
        && typeof item.id === "string" && typeof item.name === "string" && typeof item.url === "string"
        && typeof item.mimeType === "string" && typeof item.size === "number" && Number.isFinite(item.size)
        && (item.kind === "image" || item.kind === "file")).slice(0, MAX_ATTACHMENTS);
      // A page reload cancels the browser's uploads; they cannot resume from metadata.
      const error = Array.isArray(draft.pending) && draft.pending.length
        ? "页面刷新中断了未完成的上传，请重新选择文件。已上传的附件已保留。"
        : typeof draft.error === "string" ? draft.error : null;
      return attachments.length || error ? [[threadId, { attachments, pending: [], error }]] : [];
    }));
  } catch {
    // Storage may be unavailable, full, or contain a damaged previous draft.
    return {};
  }
}

interface AttachmentDraftStore {
  drafts: Record<string, AttachmentDraft>;
  setAttachments(threadId: string, update: UploadedAttachment[] | ((current: UploadedAttachment[]) => UploadedAttachment[])): void;
  upload(threadId: string, files: readonly File[]): Promise<void>;
}

// Uploads belong to a Session draft, independent of the mounted Composer.
export const useAttachmentDrafts = create<AttachmentDraftStore>((set, get) => ({
  drafts: readDrafts(),
  setAttachments: (threadId, update) => set((state) => {
    const draft = state.drafts[threadId] ?? emptyAttachmentDraft;
    return { drafts: { ...state.drafts, [threadId]: { ...draft, attachments: typeof update === "function" ? update(draft.attachments) : update } } };
  }),
  upload: async (threadId, files) => {
    const draft = get().drafts[threadId] ?? emptyAttachmentDraft;
    const remaining = MAX_ATTACHMENTS - draft.attachments.length - draft.pending.length;
    const selected = files.slice(0, Math.max(0, remaining)).map((file) => ({ file, id: crypto.randomUUID(), name: file.name }));
    if (!files.length) return;
    // Reserve slots synchronously so rapid paste/drop events cannot exceed the limit.
    set((state) => ({ drafts: { ...state.drafts, [threadId]: {
      ...draft, pending: [...draft.pending, ...selected.map(({ id, name }) => ({ id, name }))],
      error: files.length > remaining ? `每条消息最多添加 ${MAX_ATTACHMENTS} 个附件；超出的文件未上传。` : null,
    } } }));
    await Promise.all(selected.map(async ({ file, id, name }) => {
      let attachment: UploadedAttachment | undefined;
      let error: string | undefined;
      try { attachment = await endpoints.uploadAttachment(file); }
      catch (reason) { error = `${name} 上传失败：${reason instanceof Error ? reason.message : "未知错误"}`; }
      set((state) => {
        const current = state.drafts[threadId] ?? emptyAttachmentDraft;
        return { drafts: { ...state.drafts, [threadId]: {
          ...current,
          pending: current.pending.filter((item) => item.id !== id),
          attachments: attachment ? [...current.attachments, attachment] : current.attachments,
          error: error ?? current.error,
        } } };
      });
    }));
  },
}));

useAttachmentDrafts.subscribe(({ drafts }) => {
  try {
    // Keep descriptors only, never File objects or image bytes. sessionStorage
    // survives refresh without sharing an editable draft with another tab.
    const active = Object.fromEntries(Object.entries(drafts).filter(([, draft]) =>
      draft.attachments.length || draft.pending.length || draft.error));
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(active));
  } catch {
    // Upload completion must not fail because browser storage is unavailable.
  }
});
