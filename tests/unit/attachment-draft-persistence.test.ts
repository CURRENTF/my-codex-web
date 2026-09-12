import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@codex-web/shared-types";

const key = "codex-web:attachment-drafts:v1";
const image: UploadedAttachment = {
  id: "image-1", name: "screen.png", kind: "image", size: 632495,
  mimeType: "image/png", url: "/api/attachments/image-1/content",
};
let values: Map<string, string>;
async function reload() {
  vi.resetModules();
  return (await import("../../apps/web/src/attachment-drafts")).useAttachmentDrafts;
}

beforeEach(() => {
  values = new Map();
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("attachment drafts after page reload", () => {
  it("restores completed uploads in their own Session and persists removal", async () => {
    const store = await reload();
    store.getState().setAttachments("first", [image]);
    store.getState().setAttachments("second", [{ ...image, id: "image-2" }]);
    const restored = await reload();
    expect(restored.getState().drafts.first?.attachments).toEqual([image]);
    expect(restored.getState().drafts.second?.attachments[0]?.id).toBe("image-2");
    restored.getState().setAttachments("first", []);
    const removed = await reload();
    expect(removed.getState().drafts.first).toBeUndefined();
    expect(removed.getState().drafts.second?.attachments).toHaveLength(1);
  });

  it("reports interrupted uploads without restoring a permanent uploading spinner", async () => {
    const store = await reload();
    store.setState({ drafts: { first: { attachments: [image], pending: [{ id: "pending", name: "unfinished.png" }], error: null } } });
    const restored = (await reload()).getState().drafts.first;
    expect(restored?.attachments).toEqual([image]);
    expect(restored?.pending).toEqual([]);
    expect(restored?.error).toContain("刷新中断");
  });

  it("ignores corrupt storage and malformed attachment descriptors", async () => {
    values.set(key, "{broken");
    expect((await reload()).getState().drafts).toEqual({});
    values.set(key, JSON.stringify({ first: { attachments: [null, {}, { ...image, size: "bad" }, image] } }));
    expect((await reload()).getState().drafts.first?.attachments).toEqual([image]);
  });

  it("keeps uploads usable when storage access or writes throw", async () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    });
    const store = await reload();
    expect(() => store.getState().setAttachments("first", [image])).not.toThrow();
    expect(store.getState().drafts.first?.attachments).toEqual([image]);
  });
});
