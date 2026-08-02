import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { MultipartFile } from "@fastify/multipart";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { AdapterEvent } from "@codex-web/codex-adapter";
import type { SessionItem, SessionThread, SessionTurn, UploadedAttachment, UserMessagePart } from "@codex-web/shared-types";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;
const DRAFT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1_000;
const metadataFileName = "metadata.json";

export class AttachmentTooLargeError extends Error {
  readonly code = "FST_REQ_FILE_TOO_LARGE";

  constructor() {
    super(`附件超过 ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB 上限`);
    this.name = "AttachmentTooLargeError";
  }
}

interface AttachmentMetadata {
  id: string;
  name: string;
  storageName: string;
  mimeType: string;
  size: number;
  kind: "image" | "file";
  createdAt: number;
  claimedAt: number | null;
}

export interface PromptAttachment {
  kind: "image" | "file";
  name: string;
  path: string;
}

function safeFilename(value: string): string {
  const basename = path.basename(value || "attachment").normalize("NFKC");
  const cleaned = basename.replace(/[\u0000-\u001f\u007f/\\:]/g, "_").replace(/^\.+/, "").trim();
  return (cleaned || "attachment").slice(0, 160);
}

function imageMimeFromName(filename: string): string | null {
  const extension = path.extname(filename).toLocaleLowerCase();
  return ({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
  } as Record<string, string>)[extension] ?? null;
}

function imageExtension(mimeType: string): string {
  return ({ "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif", "image/bmp": ".bmp" } as Record<string, string>)[mimeType] ?? "";
}

async function detectedImageMime(filename: string): Promise<string | null> {
  const handle = await open(filename, "r");
  try {
    const bytes = Buffer.alloc(16);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const value = bytes.subarray(0, bytesRead);
    if (value.length >= 8 && value.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
    if (value.length >= 3 && value[0] === 0xff && value[1] === 0xd8 && value[2] === 0xff) return "image/jpeg";
    if (value.length >= 6 && (value.subarray(0, 6).toString("ascii") === "GIF87a" || value.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
    if (value.length >= 12 && value.subarray(0, 4).toString("ascii") === "RIFF" && value.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
    if (value.length >= 12 && value.subarray(4, 8).toString("ascii") === "ftyp" && ["avif", "avis"].includes(value.subarray(8, 12).toString("ascii"))) return "image/avif";
    if (value.length >= 2 && value.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
    return null;
  } finally {
    await handle.close();
  }
}

function validId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

interface MarkdownNode {
  type: string;
  url?: string;
  identifier?: string;
  children?: MarkdownNode[];
}

function markdownLocalImagePaths(text: string): string[] {
  const root = fromMarkdown(text) as MarkdownNode;
  const direct = new Set<string>();
  const references = new Set<string>();
  const definitions = new Map<string, string>();
  const visit = (node: MarkdownNode): void => {
    if ((node.type === "image" || node.type === "link") && node.url) direct.add(node.url);
    if ((node.type === "imageReference" || node.type === "linkReference") && node.identifier) references.add(node.identifier);
    if (node.type === "definition" && node.identifier && node.url) definitions.set(node.identifier, node.url);
    node.children?.forEach(visit);
  };
  visit(root);
  for (const identifier of references) {
    const filename = definitions.get(identifier);
    if (filename) direct.add(filename);
  }
  return [...direct];
}

export class AttachmentStore {
  readonly root: string;
  private readonly localImagePaths = new Map<string, string>();
  private readonly localImageTokens = new Map<string, string>();

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "attachments");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.cleanupExpiredDrafts();
  }

  async save(part: MultipartFile): Promise<UploadedAttachment> {
    const id = randomUUID();
    const name = safeFilename(part.filename);
    const directory = path.join(this.root, id);
    const initialContentPath = path.join(directory, name);
    await mkdir(directory, { recursive: false, mode: 0o700 });
    try {
      await pipeline(part.file, createWriteStream(initialContentPath, { flags: "wx", mode: 0o600 }));
      if (part.file.truncated) throw new AttachmentTooLargeError();
      const imageMime = await detectedImageMime(initialContentPath);
      const storageName = imageMime && imageMimeFromName(name) !== imageMime
        ? `${path.basename(name, path.extname(name)) || "image"}${imageExtension(imageMime)}`
        : name;
      const contentPath = path.join(directory, storageName);
      if (contentPath !== initialContentPath) await rename(initialContentPath, contentPath);
      const info = await stat(contentPath);
      const metadata: AttachmentMetadata = {
        id,
        name,
        storageName,
        mimeType: imageMime ?? (/^[\w.+-]+\/[\w.+-]+$/.test(part.mimetype) ? part.mimetype : "application/octet-stream"),
        size: info.size,
        kind: imageMime ? "image" : "file",
        createdAt: Date.now(),
        claimedAt: null,
      };
      await writeFile(path.join(directory, metadataFileName), JSON.stringify(metadata), { mode: 0o600, flag: "wx" });
      return this.publicDescriptor(metadata);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async resolvePromptAttachments(ids: readonly string[]): Promise<PromptAttachment[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length !== ids.length || uniqueIds.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new Error("附件列表无效");
    const records = await Promise.all(uniqueIds.map((id) => this.readMetadata(id)));
    return records.map((metadata) => ({
      kind: metadata.kind,
      name: metadata.name,
      path: path.join(this.root, metadata.id, metadata.storageName),
    }));
  }

  async claim(ids: readonly string[]): Promise<void> {
    await Promise.all([...new Set(ids)].map(async (id) => {
      const metadata = await this.readMetadata(id);
      if (metadata.claimedAt !== null) return;
      const next = { ...metadata, claimedAt: Date.now() };
      await writeFile(path.join(this.root, id, metadataFileName), JSON.stringify(next), { mode: 0o600 });
    }));
  }

  async removeDraft(id: string): Promise<boolean> {
    const metadata = await this.readMetadata(id);
    if (metadata.claimedAt !== null) return false;
    await rm(path.join(this.root, id), { recursive: true, force: true });
    return true;
  }

  async content(id: string): Promise<{ path: string; metadata: UploadedAttachment }> {
    const metadata = await this.readMetadata(id);
    return {
      path: path.join(this.root, metadata.id, metadata.storageName),
      metadata: this.publicDescriptor(metadata),
    };
  }

  openLocalImage(token: string): { path: string; mimeType: string } | null {
    const filename = this.localImagePaths.get(token);
    if (!filename) return null;
    const mimeType = imageMimeFromName(filename);
    return mimeType ? { path: filename, mimeType } : null;
  }

  decorateThread(thread: SessionThread): SessionThread {
    return { ...thread, turns: thread.turns.map((turn) => this.decorateTurn(turn)) };
  }

  async restoreThreadAttachments(thread: SessionThread, references: ReadonlyMap<string, readonly string[]>): Promise<SessionThread> {
    const partsByMessage = new Map<string, UserMessagePart[]>();
    await Promise.all([...references].map(async ([clientUserMessageId, ids]) => {
      const parts = (await Promise.all(ids.map(async (id): Promise<UserMessagePart | null> => {
        try {
          const metadata = await this.readMetadata(id);
          const contentPath = path.join(this.root, metadata.id, metadata.storageName);
          return metadata.kind === "image"
            ? { type: "localImage", path: contentPath, name: metadata.name }
            : { type: "mention", path: contentPath, name: metadata.name };
        } catch {
          return null;
        }
      }))).filter((part): part is UserMessagePart => part !== null);
      if (parts.length) partsByMessage.set(clientUserMessageId, parts);
    }));
    if (!partsByMessage.size) return thread;
    return {
      ...thread,
      turns: thread.turns.map((turn) => ({
        ...turn,
        items: turn.items.map((item) => {
          if (item.type !== "userMessage" || !item.clientId) return item;
          const referencedParts = partsByMessage.get(item.clientId);
          if (!referencedParts?.length) return item;
          const existing = new Set(item.content.flatMap((part) => part.path ? [`${part.type}\u0000${part.path}`] : []));
          const missing = referencedParts.filter((part) => part.path && !existing.has(`${part.type}\u0000${part.path}`));
          return missing.length ? { ...item, content: [...item.content, ...missing] } : item;
        }),
      })),
    };
  }

  decorateTurn(turn: SessionTurn): SessionTurn {
    return { ...turn, items: turn.items.map((item) => this.decorateItem(item)) };
  }

  decorateEvent(event: AdapterEvent): AdapterEvent {
    if (event.type === "threadStarted") return { ...event, thread: this.decorateThread(event.thread) };
    if (event.type === "turnStarted" || event.type === "turnCompleted") return { ...event, turn: this.decorateTurn(event.turn) };
    if (event.type === "itemUpserted") return { ...event, item: this.decorateItem(event.item) };
    return event;
  }

  private decorateItem(item: SessionItem): SessionItem {
    if (item.type === "userMessage") {
      return {
        ...item,
        content: item.content.map((part) => {
          if (part.type === "image" && part.url) return { ...part, displayUrl: part.url };
          if (part.type === "localImage" && part.path) return { ...part, displayUrl: this.localImageUrl(part.path) };
          if (part.type === "mention" && part.path) {
            const id = this.attachmentIdFromPath(part.path);
            return id ? { ...part, downloadUrl: `/api/attachments/${id}/content?download=1` } : part;
          }
          return part;
        }),
      };
    }
    if (item.type === "imageView") return { ...item, displayUrl: this.localImageUrl(item.path) };
    if (item.type === "imageGeneration" && item.savedPath) return { ...item, displayUrl: this.localImageUrl(item.savedPath) };
    if (item.type === "agentMessage") {
      const localImageUrls = Object.fromEntries(markdownLocalImagePaths(item.text).flatMap((filename) => {
        const url = this.localImageUrl(filename);
        return url ? [[filename, url]] : [];
      }));
      return Object.keys(localImageUrls).length ? { ...item, localImageUrls } : item;
    }
    return item;
  }

  private localImageUrl(filename: string): string | undefined {
    if (!path.isAbsolute(filename) || !imageMimeFromName(filename)) return undefined;
    let token = this.localImageTokens.get(filename);
    if (!token) {
      token = randomUUID();
      this.localImageTokens.set(filename, token);
      this.localImagePaths.set(token, filename);
    }
    return `/api/local-images/${token}/content`;
  }

  private attachmentIdFromPath(filename: string): string | null {
    const relative = path.relative(this.root, filename);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const [id] = relative.split(path.sep);
    return id && validId(id) ? id : null;
  }

  private publicDescriptor(metadata: AttachmentMetadata): UploadedAttachment {
    return {
      id: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      size: metadata.size,
      kind: metadata.kind,
      url: `/api/attachments/${metadata.id}/content`,
    };
  }

  private async readMetadata(id: string): Promise<AttachmentMetadata> {
    if (!validId(id)) throw new Error("附件不存在");
    const metadata = JSON.parse(await readFile(path.join(this.root, id, metadataFileName), "utf8")) as Partial<AttachmentMetadata>;
    if (metadata.id !== id || typeof metadata.name !== "string" || typeof metadata.storageName !== "string"
      || typeof metadata.mimeType !== "string" || typeof metadata.size !== "number"
      || (metadata.kind !== "image" && metadata.kind !== "file") || typeof metadata.createdAt !== "number"
      || (metadata.claimedAt !== null && typeof metadata.claimedAt !== "number")) throw new Error("附件元数据损坏");
    return metadata as AttachmentMetadata;
  }

  private async cleanupExpiredDrafts(): Promise<void> {
    const now = Date.now();
    const entries = await readdir(this.root, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory() && validId(entry.name)).map(async (entry) => {
      try {
        const metadata = await this.readMetadata(entry.name);
        if (metadata.claimedAt === null && now - metadata.createdAt > DRAFT_ATTACHMENT_TTL_MS) {
          await rm(path.join(this.root, entry.name), { recursive: true, force: true });
        }
      } catch {
        const info = await stat(path.join(this.root, entry.name)).catch(() => null);
        if (info && now - info.mtimeMs > DRAFT_ATTACHMENT_TTL_MS) await rm(path.join(this.root, entry.name), { recursive: true, force: true });
      }
    }));
  }
}

export function streamLocalFile(filename: string) {
  return createReadStream(filename);
}
