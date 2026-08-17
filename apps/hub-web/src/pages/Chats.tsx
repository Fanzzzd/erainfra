import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, MessageSquare, Search } from "lucide-react";
import { trpcQuery, type ChatHit, type ChatMessage, type ChatSession } from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const when = (iso?: string) => (iso ? new Date(iso).toLocaleString() : "—");
const shortProject = (p?: string) => (p ? p.split("/").slice(-2).join("/") : "—");

function SessionView({ id, onBack }: { id: string; onBack: () => void }) {
  const [session, setSession] = useState<ChatSession | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await trpcQuery<{ session: ChatSession; messages: ChatMessage[] }>(
          "chats.messages",
          { id },
        );
        setSession(r.session);
        setMessages(r.messages);
      } catch {
        /* unchanged behaviour: swallow, leaving the view on its "Loading…" state */
      }
    })();
  }, [id]);

  return (
    <div className="space-y-4">
      <Button variant="outline" size="sm" onClick={onBack}>
        <ArrowLeft /> All sessions
      </Button>
      {session && (
        <div>
          <h3 className="font-semibold">{session.title ?? session.id}</h3>
          <p className="text-muted-foreground text-sm">
            {session.source} · {session.project ?? "no project"} · {messages.length} messages ·{" "}
            {when(session.updatedAt)}
          </p>
        </div>
      )}
      <div className="space-y-3">
        {messages.map((m) => (
          <div key={m.seq} className={m.role === "user" ? "flex justify-end" : "flex"}>
            <div
              className={`max-w-[85%] rounded-lg px-4 py-2.5 text-sm ${m.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted"}`}
            >
              {m.role === "assistant" && m.model && (
                <div className="text-muted-foreground mb-1 text-xs">{m.model}</div>
              )}
              <div className="whitespace-pre-wrap break-words">
                {m.text.length > 4000 ? `${m.text.slice(0, 4000)}\n…` : m.text}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Chats() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hits, setHits] = useState<ChatHit[] | null>(null);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const refresh = useCallback(
    () =>
      trpcQuery<ChatSession[]>("chats.sessions", { limit: 100 })
        .then(setSessions)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    refresh();
  }, [refresh]);

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (!q.trim()) return setHits(null);
    setHits(await trpcQuery<ChatHit[]>("chats.search", { q, limit: 50 }).catch(() => []));
  };

  if (open) return <SessionView id={open} onBack={() => setOpen(null)} />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Chats</h2>
        <p className="text-muted-foreground text-sm">
          Every Claude Code / Codex session, archived and searchable. Sync with `portless chats
          sync`.
        </p>
      </div>

      <form onSubmit={search} className="flex max-w-xl gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Full-text search across all conversations…"
        />
        <Button type="submit">
          <Search /> Search
        </Button>
        {hits && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setHits(null);
              setQ("");
            }}
          >
            Clear
          </Button>
        )}
      </form>

      {hits ? (
        hits.length === 0 ? (
          <p className="text-muted-foreground text-sm">No matches.</p>
        ) : (
          <div className="space-y-2">
            {hits.map((h) => (
              <button
                // Search returns one hit per message, so session + seq identifies a row across
                // result sets; the index does not, and re-searching would reuse stale DOM.
                key={`${h.session.id}:${h.seq}`}
                onClick={() => setOpen(h.session.id)}
                className="hover:bg-accent block w-full rounded-md border p-3 text-left"
              >
                <div className="mb-1 flex items-center gap-2 text-xs">
                  <Badge variant="secondary">{h.session.source}</Badge>
                  <span className="text-muted-foreground">
                    {h.role} · {shortProject(h.session.project)} · {when(h.at)}
                  </span>
                </div>
                <div className="text-sm">{h.snippet}</div>
              </button>
            ))}
          </div>
        )
      ) : sessions.length === 0 ? (
        <Card>
          <CardHeader className="items-center text-center">
            <MessageSquare className="text-muted-foreground mx-auto mb-2 size-8" />
            <CardTitle>No conversations archived yet</CardTitle>
            <CardDescription>
              Run this once on each machine where you use Claude Code or Codex.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <pre className="bg-muted rounded-md p-4 text-xs leading-relaxed">
              {
                "portless chats sync        # one-off\nportless chats autosync    # keep it synced (every 15 min)"
              }
            </pre>
          </CardContent>
        </Card>
      ) : (
        <Card className="py-0">
          <CardContent className="px-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Title</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Msgs</TableHead>
                  <TableHead className="pr-6">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id} className="cursor-pointer" onClick={() => setOpen(s.id)}>
                    <TableCell className="max-w-md truncate pl-6 font-medium">
                      {s.title ?? s.id}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{s.source}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {shortProject(s.project)}
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {s.messageCount}
                    </TableCell>
                    <TableCell className="text-muted-foreground pr-6 text-xs">
                      {when(s.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
