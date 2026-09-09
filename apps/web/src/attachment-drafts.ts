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
interface AttachmentDraftStore {
  drafts: Record<string, AttachmentDraft>;
  setAttachments(threadId: string, update: UploadedAttachment[] | ((current: UploadedAttachment[]) => UploadedAttachment[])): void;
  upload(threadId: string, files: readonly File[]): Promise<void>;
}

// Uploads belong to a Session draft, independent of the mounted Composer.
export const useAttachmentDrafts = create<AttachmentDraftStore>((set, get) => ({
  drafts: {},
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
