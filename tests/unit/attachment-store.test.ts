import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type { MultipartFile } from "@fastify/multipart";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AttachmentStore, AttachmentTooLargeError } from "../../apps/server/src/attachment-store.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function part(filename: string, mimetype: string, content: Buffer, truncated = false): MultipartFile {
  const file = Object.assign(Readable.from(content), { truncated });
  return { fieldname: "file", filename, encoding: "7bit", mimetype, file } as unknown as MultipartFile;
}

describe("AttachmentStore", () => {
  let directory: string;
  let store: AttachmentStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "codex-web-attachments-"));
    store = new AttachmentStore(directory);
    await store.initialize();
  });

  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("sniffs image bytes, normalizes the storage extension, and resolves a localImage prompt", async () => {
    const uploaded = await store.save(part("../clipboard.bin", "application/octet-stream", png));
    expect(uploaded).toMatchObject({ name: "clipboard.bin", kind: "image", mimeType: "image/png", size: png.length });

    const [resolved] = await store.resolvePromptAttachments([uploaded.id]);
    expect(resolved).toMatchObject({ kind: "image", name: "clipboard.bin" });
    expect(resolved?.path).toMatch(/clipboard\.png$/);
    expect(await readFile(resolved!.path)).toEqual(png);

    await store.claim([uploaded.id]);
    await expect(store.removeDraft(uploaded.id)).resolves.toBe(false);
  });

  it("keeps arbitrary files as mention inputs and lets an unclaimed draft be removed", async () => {
    const uploaded = await store.save(part("notes.txt", "text/plain", Buffer.from("hello")));
    await expect(store.resolvePromptAttachments([uploaded.id])).resolves.toEqual([{
      kind: "file",
      name: "notes.txt",
      path: expect.stringMatching(/notes\.txt$/),
    }]);
    await expect(store.removeDraft(uploaded.id)).resolves.toBe(true);
    await expect(store.content(uploaded.id)).rejects.toThrow();
  });

  it("classifies a truncated multipart stream as an attachment size error", async () => {
    await expect(store.save(part("large.bin", "application/octet-stream", Buffer.from("partial"), true)))
      .rejects.toBeInstanceOf(AttachmentTooLargeError);
    await expect(readdir(store.root)).resolves.toEqual([]);
  });

  it("decorates uploaded and tool image paths with authenticated display URLs", async () => {
    const uploaded = await store.save(part("screen.png", "image/png", png));
    const [{ path: uploadedPath }] = await store.resolvePromptAttachments([uploaded.id]);
    const toolPath = path.join(directory, "tool.png");
    await writeFile(toolPath, png);

    const thread = store.decorateThread({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null,
      turns: [{ id: "turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1, items: [
        { type: "userMessage", id: "user", content: [{ type: "localImage", path: uploadedPath }, { type: "mention", name: "notes.txt", path: path.join(store.root, uploaded.id, "notes.txt") }] },
        { type: "imageView", id: "view", path: toolPath },
      ] }],
    });
    const user = thread.turns[0]?.items[0];
    const view = thread.turns[0]?.items[1];
    expect(user).toMatchObject({ type: "userMessage", content: [
      { displayUrl: expect.stringMatching(/^\/api\/local-images\/.+\/content$/) },
      { downloadUrl: `/api/attachments/${uploaded.id}/content?download=1` },
    ] });
    expect(view).toMatchObject({ type: "imageView", displayUrl: expect.stringMatching(/^\/api\/local-images\/.+\/content$/) });
    if (view?.type !== "imageView" || !view.displayUrl) throw new Error("missing image URL");
    const token = view.displayUrl.split("/")[3]!;
    const snapshot = store.openLocalImage(token);
    expect(snapshot).toMatchObject({ path: expect.stringMatching(/\/local-images\/.+\.png$/), mimeType: "image/png" });
    expect(await readFile(snapshot!.path)).toEqual(png);
  });

  it("keeps an embedded image immutable while a path hyperlink follows later file updates", async () => {
    const sourcePath = path.join(directory, "result.png");
    const firstImage = Buffer.concat([png, Buffer.from("first")]);
    const secondImage = Buffer.concat([png, Buffer.from("second")]);
    await writeFile(sourcePath, firstImage);
    const text = `![embedded](${sourcePath})\n\n[current path](${sourcePath})`;

    const firstThread = store.decorateThread({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null,
      turns: [{ id: "turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1, items: [
        { type: "agentMessage", id: "agent", text },
      ] }],
    });
    const firstAgent = firstThread.turns[0]?.items[0];
    if (firstAgent?.type !== "agentMessage") throw new Error("missing agent message");
    const embeddedUrl = firstAgent.localImageUrls?.[sourcePath];
    const pathUrl = firstAgent.localPathUrls?.[sourcePath];
    if (!embeddedUrl || !pathUrl) throw new Error("missing local image URLs");
    const embeddedToken = embeddedUrl.split("/")[3]!;
    const pathToken = pathUrl.split("/")[3]!;
    expect(embeddedUrl).toMatch(/^\/api\/local-images\/.+\/content$/);
    expect(pathUrl).toMatch(/^\/api\/local-paths\/.+\/content$/);
    expect(await readFile(store.openLocalImage(embeddedToken)!.path)).toEqual(firstImage);
    expect(await readFile(store.openLocalPath(pathToken)!.path)).toEqual(firstImage);

    await writeFile(sourcePath, secondImage);
    expect(await readFile(store.openLocalImage(embeddedToken)!.path)).toEqual(firstImage);
    expect(await readFile(store.openLocalPath(pathToken)!.path)).toEqual(secondImage);

    const laterThread = store.decorateThread({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null,
      turns: [{ id: "later-turn", status: "completed", startedAt: 3, completedAt: 4, durationMs: 1, items: [
        { type: "agentMessage", id: "later-agent", text: `![later embedded](${sourcePath})` },
      ] }],
    });
    const laterAgent = laterThread.turns[0]?.items[0];
    if (laterAgent?.type !== "agentMessage") throw new Error("missing later agent message");
    const laterUrl = laterAgent.localImageUrls?.[sourcePath];
    if (!laterUrl) throw new Error("missing later image URL");
    expect(laterUrl).not.toBe(embeddedUrl);
    expect(await readFile(store.openLocalImage(laterUrl.split("/")[3]!)!.path)).toEqual(secondImage);

    const restartedStore = new AttachmentStore(directory);
    await restartedStore.initialize();
    expect(await readFile(restartedStore.openLocalImage(embeddedToken)!.path)).toEqual(firstImage);
    expect(await readFile(restartedStore.openLocalPath(pathToken)!.path)).toEqual(secondImage);
    const restored = restartedStore.decorateThread({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 2, ephemeral: false, forkedFromId: null,
      turns: [{ id: "turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1, items: [
        { type: "agentMessage", id: "agent", text },
      ] }],
    });
    const restoredAgent = restored.turns[0]?.items[0];
    if (restoredAgent?.type !== "agentMessage") throw new Error("missing restored agent message");
    expect(restoredAgent.localImageUrls?.[sourcePath]).toBe(embeddedUrl);
    expect(restoredAgent.localPathUrls?.[sourcePath]).toBe(pathUrl);
  });

  it("decorates local images embedded in agent Markdown without rewriting the source text", async () => {
    const inlinePath = path.join(directory, "inline.png");
    const referencedPath = path.join(directory, "referenced image.jpg");
    const linkedPath = path.join(directory, "linked.webp");
    await writeFile(inlinePath, png);
    await writeFile(referencedPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await writeFile(linkedPath, Buffer.from("linked image"));
    const text = [
      `![inline](${inlinePath})`,
      `![referenced][figure]`,
      `[figure]: <${referencedPath}>`,
      `[open linked image](${linkedPath})`,
      `![external](https://example.com/remote.png)`,
      "`![code](/tmp/not-an-image.png)`",
    ].join("\n\n");

    const thread = store.decorateThread({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null,
      turns: [{ id: "turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1, items: [
        { type: "agentMessage", id: "agent", text },
      ] }],
    });
    const agent = thread.turns[0]?.items[0];
    expect(agent).toMatchObject({ type: "agentMessage", text });
    if (agent?.type !== "agentMessage") throw new Error("missing agent message");
    expect(agent.localImageUrls).toEqual({
      [inlinePath]: expect.stringMatching(/^\/api\/local-images\/.+\/content$/),
      [referencedPath]: expect.stringMatching(/^\/api\/local-images\/.+\/content$/),
    });
    expect(agent.localPathUrls).toEqual({
      [linkedPath]: expect.stringMatching(/^\/api\/local-paths\/.+\/content$/),
    });
    for (const url of Object.values(agent.localImageUrls ?? {})) {
      const token = url.split("/")[3]!;
      expect(store.openLocalImage(token)?.path).toMatch(/\/local-images\/.+\.(png|jpg)$/);
    }
    const linkedToken = agent.localPathUrls![linkedPath]!.split("/")[3]!;
    expect(store.openLocalPath(linkedToken)).toEqual({ path: linkedPath, mimeType: "image/webp" });
  });

  it("restores attachment parts omitted from a persisted App Server user message without duplicating images", async () => {
    const image = await store.save(part("screen.png", "image/png", png));
    const file = await store.save(part("notes.txt", "text/plain", Buffer.from("hello")));
    const [{ path: imagePath }] = await store.resolvePromptAttachments([image.id]);
    const restored = await store.restoreThreadAttachments({
      id: "thread", preview: "", name: null, cwd: directory, createdAt: 1, updatedAt: 1, ephemeral: false, forkedFromId: null,
      turns: [{ id: "turn", status: "completed", startedAt: 1, completedAt: 2, durationMs: 1, items: [
        { type: "userMessage", id: "user", clientId: "message-1", content: [{ type: "localImage", path: imagePath }] },
      ] }],
    }, new Map([["message-1", [image.id, file.id]]]));

    const user = restored.turns[0]?.items[0];
    expect(user).toMatchObject({ type: "userMessage", content: [
      { type: "localImage", path: imagePath },
      { type: "mention", name: "notes.txt", path: expect.stringMatching(/notes\.txt$/) },
    ] });
  });
});
