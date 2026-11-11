// `ctx.storage` on the Cloudflare platform. A file's metadata is a row in the `_storage` system
// table, written in the caller's transaction; its bytes go to a FileStore (R2 on Cloudflare).
// Upload URLs carry a one-time token kept in `_storage_uploads`.

import type { JSONValue, Value } from "convex/values";

import { prefixRange } from "../store/keys.ts";
import type { Store, Transaction } from "../store/store.ts";

export const STORAGE = "_storage";
export const UPLOADS = "_storage_uploads";
const UPLOAD_TTL_MS = 60 * 60 * 1000;

/** Where `ctx.storage` keeps file bytes. R2 on Cloudflare, memory in tests. */
export interface FileStore {
  put(key: string, bytes: Uint8Array, contentType: string | undefined): Promise<void>;
  get(key: string): Promise<{ bytes: Uint8Array; contentType: string | undefined } | null>;
  delete(key: string): Promise<void>;
}

/** What Files needs from the runtime. */
export type FilesHost = {
  store: Store;
  /** Runs `fn` in the runtime's queue of queries and mutations. */
  serialized<T>(fn: () => Promise<T>): Promise<T>;
  now(): number;
  siteUrl: string | undefined;
  files: FileStore | undefined;
};

async function sha256Base64(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return btoa(String.fromCharCode(...digest));
}

export class Files {
  constructor(private readonly host: FilesHost) {}

  private bytesStore(): FileStore {
    if (!this.host.files)
      throw new Error("ctx.storage needs a file store (R2) on the Cloudflare platform");
    return this.host.files;
  }

  // Runs `fn` in the caller's transaction, or in a new one that commits, for actions.
  private inTransaction<T>(tx: Transaction | null, fn: (tx: Transaction) => Promise<T> | T) {
    if (tx) return Promise.resolve(fn(tx));
    return this.host.serialized(async () => {
      const own = this.host.store.begin();
      const out = await fn(own);
      own.commit();
      return out;
    });
  }

  private row(tx: Transaction | null, id: string): Record<string, Value | undefined> | null {
    const found = tx?.writes.get(id) ?? this.host.store.readDoc(id);
    if (!found || found.table !== STORAGE || !found.doc) return null;
    return found.doc;
  }

  /** A one-time upload URL, valid for an hour, as Convex's are. */
  async uploadUrl(tx: Transaction | null): Promise<string> {
    const token = crypto.randomUUID().replaceAll("-", "");
    await this.inTransaction(tx, (t) =>
      t.insertSystem(UPLOADS, { token, expiresAt: this.host.now() + UPLOAD_TTL_MS }),
    );
    return `${this.host.siteUrl ?? ""}/api/storage/upload?token=${token}`;
  }

  /** Stores the body of a POST to an upload URL. Returns the storage ID, or null for a bad token. */
  async upload(
    token: string,
    bytes: Uint8Array,
    contentType: string | undefined,
  ): Promise<string | null> {
    const sha256 = await sha256Base64(bytes);
    return this.host.serialized(async () => {
      const tx = this.host.store.begin();
      const row = tx
        .scan({
          table: UPLOADS,
          index: "by_token",
          ...prefixRange([token]),
          desc: false,
          matches: () => true,
        })
        .next();
      if (row.done || (row.value.doc.expiresAt as number) < this.host.now()) return null;
      tx.writes.set(row.value.doc._id as string, { table: UPLOADS, doc: null });
      const id = tx.insertSystem(STORAGE, { sha256, size: bytes.length, contentType });
      await this.bytesStore().put(id, bytes, contentType);
      tx.commit();
      return id;
    });
  }

  async store(
    tx: Transaction | null,
    bytes: Uint8Array,
    contentType: string | undefined,
  ): Promise<string> {
    const sha256 = await sha256Base64(bytes);
    return this.inTransaction(tx, async (t) => {
      const id = t.insertSystem(STORAGE, { sha256, size: bytes.length, contentType });
      await this.bytesStore().put(id, bytes, contentType);
      return id;
    });
  }

  async bytes(
    tx: Transaction | null,
    id: string,
  ): Promise<{ bytes: Uint8Array; contentType: string | undefined } | null> {
    if (!this.row(tx, id)) return null;
    return this.bytesStore().get(id);
  }

  /** The `1.0/storageGet` reply: the file as base64. */
  async getJson(tx: Transaction | null, id: string): Promise<JSONValue> {
    const file = await this.bytes(tx, id);
    if (!file) return null;
    return {
      blob: btoa(String.fromCharCode(...file.bytes)),
      contentType: file.contentType ?? null,
    };
  }

  url(tx: Transaction | null, id: string): JSONValue {
    if (!this.row(tx, id)) return null;
    return `${this.host.siteUrl ?? ""}/api/storage/${id}`;
  }

  metadata(tx: Transaction | null, id: string): JSONValue {
    const row = this.row(tx, id);
    if (!row) return null;
    return {
      storageId: id,
      sha256: row.sha256 as string,
      size: row.size as number,
      contentType: (row.contentType as string | undefined) ?? null,
    };
  }

  async delete(tx: Transaction | null, id: string): Promise<void> {
    if (!this.row(tx, id)) return;
    await this.inTransaction(tx, async (t) => {
      t.writes.set(id, { table: STORAGE, doc: null });
      await this.bytesStore().delete(id);
    });
  }
}
