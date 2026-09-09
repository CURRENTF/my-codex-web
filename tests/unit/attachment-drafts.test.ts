import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UploadedAttachment } from "@codex-web/shared-types";
import { endpoints } from "../../apps/web/src/api";
import { useAttachmentDrafts } from "../../apps/web/src/attachment-drafts";

vi.mock("../../apps/web/src/api", () => ({ endpoints: { uploadAttachment: vi.fn() } }));
function deferred() {
  let resolve!: (value: UploadedAttachment) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<UploadedAttachment>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const file = (name: string) => new File(["test"], name);
const attachment = (name: string) => ({ id: name, name, kind: "file", size: 4, mimeType: "text/plain", url: `/attachments/${name}` }) as UploadedAttachment;

beforeEach(() => { useAttachmentDrafts.setState({ drafts: {} }); vi.mocked(endpoints.uploadAttachment).mockReset(); });
describe("Session attachment drafts", () => {
  it("publishes each completed file without waiting for the slow file and keeps uploads in their original Session", async () => {
    const slow = deferred(); const fast = deferred(); const other = deferred();
    vi.mocked(endpoints.uploadAttachment).mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise).mockReturnValueOnce(other.promise);
    const first = useAttachmentDrafts.getState().upload("first", [file("slow"), file("fast")]);
    // A newly mounted Composer can select another Session while the first upload continues.
    const second = useAttachmentDrafts.getState().upload("second", [file("other")]);
    fast.resolve(attachment("fast"));
    await Promise.resolve();
    expect(useAttachmentDrafts.getState().drafts.first).toMatchObject({ attachments: [attachment("fast")], pending: [{ name: "slow" }] });
    expect(useAttachmentDrafts.getState().drafts.second?.attachments).toEqual([]);
    other.resolve(attachment("other")); await second;
    slow.resolve(attachment("slow")); await first;
    expect(useAttachmentDrafts.getState().drafts.first?.attachments.map((item) => item.name)).toEqual(["fast", "slow"]);
    expect(useAttachmentDrafts.getState().drafts.second?.attachments).toEqual([attachment("other")]);
    expect(useAttachmentDrafts.getState().drafts.first?.pending).toEqual([]);
  });

  it("retains failures in the owning Session and preserves successful files", async () => {
    vi.mocked(endpoints.uploadAttachment).mockResolvedValueOnce(attachment("good")).mockRejectedValueOnce(new Error("offline"));
    await useAttachmentDrafts.getState().upload("first", [file("good"), file("bad")]);
    expect(useAttachmentDrafts.getState().drafts.first).toMatchObject({ attachments: [attachment("good")], pending: [], error: "bad 上传失败：offline" });
    useAttachmentDrafts.getState().setAttachments("second", []);
    expect(useAttachmentDrafts.getState().drafts.first?.attachments).toEqual([attachment("good")]);
  });

  it("reserves slots before awaiting requests and frees only submitted attachments", async () => {
    const pending = deferred();
    vi.mocked(endpoints.uploadAttachment).mockReturnValue(pending.promise);
    const batch = useAttachmentDrafts.getState().upload("first", Array.from({ length: 10 }, (_, index) => file(String(index))));
    await useAttachmentDrafts.getState().upload("first", [file("overflow")]);
    expect(endpoints.uploadAttachment).toHaveBeenCalledTimes(10);
    pending.resolve(attachment("done")); await batch;
    useAttachmentDrafts.getState().setAttachments("second", [attachment("keep")]);
    useAttachmentDrafts.getState().setAttachments("first", (current) => current.filter((item) => item.id !== "done"));
    expect(useAttachmentDrafts.getState().drafts.first?.attachments).toEqual([]);
    expect(useAttachmentDrafts.getState().drafts.second?.attachments).toEqual([attachment("keep")]);
  });
});
