// Gmail-style instant inbox cache using IndexedDB.
// - Per-user namespaced DB so admin impersonation doesn't leak data across users.
// - `emailMeta` store keyed on id, indexes on date + modseq.
// - `syncMeta` stores last delta cursor for incremental sync.
// - Full HTML is stored per-row when available (lazy-loaded on click).
import { openDB, type IDBPDatabase, type DBSchema } from "idb";

export interface CachedEmail {
  id: string;
  subject?: string | null;
  from?: string | null;
  to?: string | null;
  date: string;                   // ISO string (server-side timestamptz)
  preview?: string | null;
  otp?: string | null;
  html?: string | null;           // may be absent — fetched lazily
  account_label?: string | null;
  modseq: number;
  destroyed?: boolean;
}

interface InboxSchema extends DBSchema {
  emailMeta: {
    key: string;
    value: CachedEmail;
    indexes: {
      "by-date": string;
      "by-modseq": number;
    };
  };
  emailHtml: {
    key: string;                  // email id
    value: { id: string; html: string; cached_at: number };
  };
  syncMeta: {
    key: string;                  // "global"
    value: { cursor: number; updated_at: number };
  };
}

const DB_VERSION = 1;
const DB_PREFIX = "nf-inbox-";

function dbName(userId: string) {
  const safe = String(userId || "anon").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return `${DB_PREFIX}${safe}`;
}

export async function openInboxDB(userId: string): Promise<IDBPDatabase<InboxSchema>> {
  return openDB<InboxSchema>(dbName(userId), DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("emailMeta")) {
        const s = db.createObjectStore("emailMeta", { keyPath: "id" });
        s.createIndex("by-date", "date");
        s.createIndex("by-modseq", "modseq");
      }
      if (!db.objectStoreNames.contains("emailHtml")) {
        db.createObjectStore("emailHtml", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("syncMeta")) {
        db.createObjectStore("syncMeta");
      }
    },
    blocked() { /* another tab holds an older version */ },
    blocking() { /* new version wants to open; close so it can */ },
    terminated() { /* browser evicted */ },
  });
}

/** Read newest N non-destroyed rows via the date index (fast — no full scan). */
export async function readLatestEmails(
  db: IDBPDatabase<InboxSchema>,
  limit = 50,
  allowedAccountLabels?: string[] | null,
): Promise<CachedEmail[]> {
  const out: CachedEmail[] = [];
  const allowed = Array.isArray(allowedAccountLabels)
    ? new Set(allowedAccountLabels.map((s) => String(s || "").trim()).filter(Boolean))
    : null;
  if (allowed && allowed.size === 0) return [];
  const tx = db.transaction("emailMeta", "readonly");
  const idx = tx.store.index("by-date");
  let cursor = await idx.openCursor(null, "prev");   // newest first
  while (cursor && out.length < limit) {
    const v = cursor.value;
    const label = String(v.account_label || "").trim();
    if (!v.destroyed && (!allowed || (label && allowed.has(label)))) out.push(v);
    cursor = await cursor.continue();
  }
  await tx.done;
  return out;
}

/** Remove local rows that are outside the logged-in user's current account scope. */
export async function purgeEmailsOutsideScope(
  db: IDBPDatabase<InboxSchema>,
  allowedAccountLabels?: string[] | null,
): Promise<void> {
  if (!Array.isArray(allowedAccountLabels)) return;
  const allowed = new Set(allowedAccountLabels.map((s) => String(s || "").trim()).filter(Boolean));
  const tx = db.transaction(["emailMeta", "emailHtml"], "readwrite");
  let cursor = await tx.objectStore("emailMeta").openCursor();
  while (cursor) {
    const row = cursor.value;
    const label = String(row.account_label || "").trim();
    if (!label || !allowed.has(label)) {
      await tx.objectStore("emailHtml").delete(row.id);
      await cursor.delete();
    }
    cursor = await cursor.continue();
  }
  await tx.done;
}

/** Apply a delta batch atomically. */
export async function writeDelta(
  db: IDBPDatabase<InboxSchema>,
  batch: { rows: CachedEmail[]; removedIds: string[]; newCursor: number },
): Promise<void> {
  if (batch.rows.length === 0 && batch.removedIds.length === 0 && !batch.newCursor) return;
  const tx = db.transaction(["emailMeta", "syncMeta"], "readwrite");
  const meta = tx.objectStore("emailMeta");
  for (const row of batch.rows) {
    // Preserve any locally cached html we may have if server row omits it.
    if (!row.html) {
      const existing = await meta.get(row.id);
      if (existing?.html) row.html = existing.html;
    }
    await meta.put(row);
  }
  for (const id of batch.removedIds) {
    const existing = await meta.get(id);
    if (existing) await meta.put({ ...existing, destroyed: true });
  }
  if (batch.newCursor) {
    await tx.objectStore("syncMeta").put(
      { cursor: batch.newCursor, updated_at: Date.now() },
      "global",
    );
  }
  await tx.done;
}

export async function getSyncCursor(db: IDBPDatabase<InboxSchema>): Promise<number> {
  const m = await db.get("syncMeta", "global");
  return m?.cursor || 0;
}

/** Store fetched HTML separately + also on the meta row so subsequent reads have it inline. */
export async function cacheEmailHtml(
  db: IDBPDatabase<InboxSchema>,
  id: string,
  html: string,
): Promise<void> {
  const tx = db.transaction(["emailMeta", "emailHtml"], "readwrite");
  await tx.objectStore("emailHtml").put({ id, html, cached_at: Date.now() });
  const meta = tx.objectStore("emailMeta");
  const existing = await meta.get(id);
  if (existing) await meta.put({ ...existing, html });
  await tx.done;
}

export async function getEmailHtml(
  db: IDBPDatabase<InboxSchema>,
  id: string,
): Promise<string | null> {
  const row = await db.get("emailHtml", id);
  if (row?.html) return row.html;
  const meta = await db.get("emailMeta", id);
  return meta?.html || null;
}

/** Wipe cache for a user (used on logout of that user). */
export async function clearInboxCache(userId: string): Promise<void> {
  try { indexedDB.deleteDatabase(dbName(userId)); } catch { /* ignore */ }
}

/** Wipe every local inbox DB on this device. Used as a logout/shared-device safety sweep. */
export async function clearAllInboxCaches(): Promise<void> {
  try {
    const listDatabases = (indexedDB as any).databases;
    if (typeof listDatabases !== "function") return;
    const dbs = await listDatabases.call(indexedDB);
    await Promise.all(
      (dbs || [])
        .map((db: any) => String(db?.name || ""))
        .filter((name: string) => name.startsWith(DB_PREFIX))
        .map((name: string) => new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase(name);
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
          req.onblocked = () => resolve();
        })),
    );
  } catch { /* ignore */ }
}
