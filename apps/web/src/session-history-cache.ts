import type { SessionPayload } from "./api";

export interface SessionSync {
  version: 1;
  retainedCount: number;
  prefixCount: number;
  prefixHash: string;
}
export interface CachedSession { id: string; payload: SessionPayload; sync: SessionSync; touchedAt: number; bytes: number }
const MAX_ENTRIES = 20;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const memory = new Map<string, CachedSession>();
let lastWrite = 0;
let database: Promise<IDBDatabase | null> | undefined;
function openDatabase(): Promise<IDBDatabase | null> {
  return database ??= new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    try {
      // Storage may be blocked by another tab; never hold network loading indefinitely.
      const timeout = setTimeout(() => resolve(null), 500);
      const request = indexedDB.open("codex-web-session-history-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("sessions", { keyPath: "id" });
        request.result.createObjectStore("metadata", { keyPath: "id" });
      };
      request.onsuccess = () => { clearTimeout(timeout); resolve(request.result); };
      request.onerror = request.onblocked = () => { clearTimeout(timeout); resolve(null); };
    } catch { resolve(null); }
  });
}
function remember(entry: CachedSession) {
  memory.delete(entry.id);
  memory.set(entry.id, entry);
  let bytes = [...memory.values()].reduce((sum, value) => sum + value.bytes, 0);
  for (const [id, value] of memory) {
    if (memory.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
    memory.delete(id); bytes -= value.bytes;
  }
}
export async function readSessionHistory(id: string): Promise<CachedSession | undefined> {
  const cached = memory.get(id);
  if (cached && Date.now() - cached.touchedAt < MAX_AGE) { remember(cached); return cached; }
  const db = await openDatabase();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const request = db.transaction("sessions").objectStore("sessions").get(id);
      request.onerror = () => resolve(undefined);
      request.onsuccess = () => {
        const entry = request.result as CachedSession | undefined;
        if (!entry || entry.sync?.version !== 1 || entry.payload?.thread?.id !== id || !Array.isArray(entry.payload.thread.turns) || entry.sync.prefixCount > entry.payload.thread.turns.length || Date.now() - entry.touchedAt > MAX_AGE) return resolve(undefined);
        remember(entry); resolve(entry);
      };
    } catch { resolve(undefined); }
  });
}
export async function writeSessionHistory(id: string, payload: SessionPayload, sync: SessionSync): Promise<void> {
  const bytes = JSON.stringify(payload).length * 2;
  if (bytes > MAX_BYTES) return;
  lastWrite = Math.max(Date.now(), lastWrite + 1);
  const entry = { id, payload, sync, touchedAt: lastWrite, bytes };
  remember(entry);
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(["sessions", "metadata"], "readwrite");
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => resolve();
      const store = tx.objectStore("sessions");
      store.put(entry);
      const metadata = tx.objectStore("metadata");
      metadata.put({ id, touchedAt: entry.touchedAt, bytes });
      // Eviction reads only small metadata records, never all cached histories.
      const request = metadata.getAll();
      request.onsuccess = () => {
        const entries = (request.result as Pick<CachedSession, "id" | "touchedAt" | "bytes">[]).sort((a, b) => b.touchedAt - a.touchedAt);
        let total = 0;
        entries.forEach((value, index) => {
          total += value.bytes;
          if (index >= MAX_ENTRIES || total > MAX_BYTES || Date.now() - value.touchedAt > MAX_AGE) {
            store.delete(value.id);
            metadata.delete(value.id);
          }
        });
      };
    } catch { resolve(); }
  });
}
export async function removeSessionHistory(id: string): Promise<void> {
  memory.delete(id);
  const db = await openDatabase();
  if (!db) return;
  try { const tx = db.transaction(["sessions", "metadata"], "readwrite"); tx.objectStore("sessions").delete(id); tx.objectStore("metadata").delete(id); } catch { /* Cache is optional. */ }
}

export function reconstructSession(response: SessionPayload & { sync: SessionSync }, cached?: CachedSession): SessionPayload {
  const { sync, ...payload } = response;
  if (sync.retainedCount && (!cached || sync.retainedCount !== cached.sync.prefixCount || sync.retainedCount > cached.payload.thread.turns.length)) throw new Error("Session cache prefix is unavailable");
  return { ...payload, thread: { ...payload.thread, turns: [...(cached?.payload.thread.turns.slice(0, sync.retainedCount) ?? []), ...payload.thread.turns] } };
}
