// AI conversation archive: normalized Claude Code / Codex CLI transcripts, synced up from each
// machine by `portless chats sync` and searchable via SQLite FTS5. Ingestion replaces a whole
// session (transcript files are append-only and re-sent when they grow), which keeps the sync
// protocol stateless on the hub side and the FTS index trivially consistent.
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";

export interface ChatSessionMeta {
  id: string;
  source: "claude" | "codex";
  host: string; // machine the transcript came from
  project?: string; // cwd of the session
  title?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface ChatMessage {
  seq: number;
  role: "user" | "assistant";
  model?: string;
  at?: string;
  text: string;
}

export interface ChatSession extends ChatSessionMeta {
  messageCount: number;
}

interface SessionRow {
  id: string;
  source: string;
  host: string;
  project: string | null;
  title: string | null;
  started_at: string | null;
  updated_at: string | null;
  message_count: number;
}

const toSession = (r: SessionRow): ChatSession => ({
  id: r.id,
  source: r.source as ChatSessionMeta["source"],
  host: r.host,
  project: r.project ?? undefined,
  title: r.title ?? undefined,
  startedAt: r.started_at ?? undefined,
  updatedAt: r.updated_at ?? undefined,
  messageCount: Number(r.message_count),
});

// FTS5 MATCH has its own query syntax — quote each term so user input can't be a syntax error.
export const ftsQuery = (q: string): string =>
  q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replaceAll('"', '""')}"`)
    .join(" ");

export class ChatStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  // Idempotent full-session upsert: delete + reinsert messages and their FTS rows.
  replaceSession(meta: ChatSessionMeta, messages: ChatMessage[]): void {
    this.d.exec("BEGIN");
    try {
      this.d
        .prepare(`INSERT INTO chat_sessions (id, source, host, project, title, started_at, updated_at, message_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET source = excluded.source, host = excluded.host, project = excluded.project,
           title = excluded.title, started_at = excluded.started_at, updated_at = excluded.updated_at, message_count = excluded.message_count`)
        .run(
          meta.id,
          meta.source,
          meta.host,
          meta.project ?? null,
          meta.title ?? null,
          meta.startedAt ?? null,
          meta.updatedAt ?? null,
          messages.length,
        );
      this.d.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(meta.id);
      this.d.prepare("DELETE FROM chat_fts WHERE session_id = ?").run(meta.id);
      const insMsg = this.d.prepare(
        "INSERT INTO chat_messages (session_id, seq, role, model, at, text) VALUES (?, ?, ?, ?, ?, ?)",
      );
      const insFts = this.d.prepare(
        "INSERT INTO chat_fts (text, session_id, seq) VALUES (?, ?, ?)",
      );
      for (const m of messages) {
        insMsg.run(meta.id, m.seq, m.role, m.model ?? null, m.at ?? null, m.text);
        insFts.run(m.text, meta.id, m.seq);
      }
      this.d.exec("COMMIT");
    } catch (e) {
      this.d.exec("ROLLBACK");
      throw e;
    }
  }

  remove(id: string): boolean {
    const ok = this.d.prepare("DELETE FROM chat_sessions WHERE id = ?").run(id).changes > 0;
    this.d.prepare("DELETE FROM chat_messages WHERE session_id = ?").run(id);
    this.d.prepare("DELETE FROM chat_fts WHERE session_id = ?").run(id);
    return ok;
  }

  get(id: string): ChatSession | undefined {
    const r = this.d.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as
      | SessionRow
      | undefined;
    return r && toSession(r);
  }

  // Most recently active first; filter by source and/or a project substring.
  listSessions(opts: { source?: string; project?: string; limit?: number } = {}): ChatSession[] {
    const cond: string[] = [];
    const params: string[] = [];
    if (opts.source) {
      cond.push("source = ?");
      params.push(opts.source);
    }
    if (opts.project) {
      cond.push("project LIKE ?");
      params.push(`%${opts.project}%`);
    }
    const where = cond.length ? `WHERE ${cond.join(" AND ")}` : "";
    const rows = this.d
      .prepare(`SELECT * FROM chat_sessions ${where} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, opts.limit ?? 50);
    return (rows as unknown as SessionRow[]).map(toSession);
  }

  messages(sessionId: string): ChatMessage[] {
    const rows = this.d
      .prepare(
        "SELECT seq, role, model, at, text FROM chat_messages WHERE session_id = ? ORDER BY seq",
      )
      .all(sessionId);
    return (
      rows as unknown as Array<{
        seq: number;
        role: string;
        model: string | null;
        at: string | null;
        text: string;
      }>
    ).map((r) => ({
      seq: Number(r.seq),
      role: r.role as ChatMessage["role"],
      model: r.model ?? undefined,
      at: r.at ?? undefined,
      text: r.text,
    }));
  }

  // Full-text search across every synced conversation; one best hit per message with a snippet.
  // The trigram FTS index handles any term of >= 3 characters (including CJK); shorter terms fall
  // below the trigram window, so those queries take a LIKE scan instead (fine at this scale).
  // Snippets are built by hand from the message text — trigram's snippet() marks 3-char fragments,
  // which reads terribly.
  search(
    q: string,
    limit = 20,
  ): Array<{ session: ChatSession; seq: number; role: string; at?: string; snippet: string }> {
    const terms = q.split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    let rows: Array<{
      session_id: string;
      seq: number;
      role: string;
      at: string | null;
      text: string;
    }>;
    if (terms.every((t) => [...t].length >= 3)) {
      rows = this.d
        .prepare(
          `SELECT m.session_id, m.seq, m.role, m.at, m.text
           FROM chat_fts f JOIN chat_messages m ON m.session_id = f.session_id AND m.seq = f.seq
          WHERE chat_fts MATCH ? ORDER BY rank LIMIT ?`,
        )
        .all(ftsQuery(q), limit) as never;
    } else {
      const esc = (t: string) =>
        t.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
      const cond = terms.map(() => "text LIKE ? ESCAPE '\\'").join(" AND ");
      rows = this.d
        .prepare(
          `SELECT session_id, seq, role, at, text FROM chat_messages WHERE ${cond} ORDER BY rowid DESC LIMIT ?`,
        )
        .all(...terms.map((t) => `%${esc(t)}%`), limit) as never;
    }
    const out: Array<{
      session: ChatSession;
      seq: number;
      role: string;
      at?: string;
      snippet: string;
    }> = [];
    for (const r of rows) {
      const session = this.get(r.session_id);
      if (!session) continue;
      out.push({
        session,
        seq: Number(r.seq),
        role: r.role,
        at: r.at ?? undefined,
        snippet: buildSnippet(r.text, terms),
      });
    }
    return out;
  }

  stats(): { sessions: number; messages: number } {
    return {
      sessions: Number(
        (this.d.prepare("SELECT COUNT(*) n FROM chat_sessions").get() as { n: number }).n,
      ),
      messages: Number(
        (this.d.prepare("SELECT COUNT(*) n FROM chat_messages").get() as { n: number }).n,
      ),
    };
  }
}

// Mark the first matching term in context: "… before [term] after …".
function buildSnippet(text: string, terms: string[]): string {
  const flat = text.replaceAll("\n", " ");
  const lower = flat.toLowerCase();
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i < 0) continue;
    const a = Math.max(0, i - 40);
    const b = Math.min(flat.length, i + t.length + 90);
    return `${a > 0 ? "… " : ""}${flat.slice(a, i)}[${flat.slice(i, i + t.length)}]${flat.slice(i + t.length, b)}${b < flat.length ? " …" : ""}`;
  }
  return flat.slice(0, 130) + (flat.length > 130 ? " …" : ""); // FTS matched but not verbatim (rare)
}

export const chatStore = new ChatStore();
