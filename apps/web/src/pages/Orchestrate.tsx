import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Bot, Sparkles, Play, ShieldCheck, ShieldAlert } from 'lucide-react';
import { trpcQuery, trpcMutation } from '@/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

type Agent = 'codex' | 'claude';
type Mode = 'plan' | 'execute';
interface RunResult {
  agent: Agent;
  mode: Mode;
  ok: boolean;
  output: string;
  durationMs: number;
}

const AGENT_LABEL: Record<Agent, string> = { codex: 'Codex', claude: 'Claude Code' };

export function Orchestrate() {
  const [avail, setAvail] = useState<{ codex: boolean; claude: boolean } | null>(null);
  const [agent, setAgent] = useState<Agent>('codex');
  const [mode, setMode] = useState<Mode>('plan');
  const [task, setTask] = useState('Summarize what services this project deploys and how they connect.');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  useEffect(() => {
    trpcQuery<{ codex: boolean; claude: boolean }>('orchestrate.agents')
      .then(setAvail)
      .catch(() => setAvail({ codex: false, claude: false }));
  }, []);

  function run() {
    if (!task.trim()) return toast.error('Describe a task first');
    // Plan mode is read-only/safe → run immediately. Execute can modify files via the AI CLI,
    // so gate it behind a typed confirmation (same posture as Cloudflare mutations).
    if (mode === 'execute') {
      setConfirmText('');
      setConfirming(true);
      return;
    }
    doRun(false);
  }

  async function doRun(confirm: boolean) {
    setBusy(true);
    setResult(null);
    setConfirming(false);
    try {
      const res = await trpcMutation<RunResult>('orchestrate.run', { agent, task, mode, confirm });
      setResult(res);
      toast[res.ok ? 'success' : 'error'](`${AGENT_LABEL[agent]} ${res.ok ? 'finished' : 'failed'} in ${(res.durationMs / 1000).toFixed(1)}s`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Orchestrate</h2>
        <p className="text-muted-foreground text-sm">
          Drive your local AI coding agents to plan and manage services. Reuses each CLI's local auth — no extra login.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Task</CardTitle>
            <CardDescription>Plan mode is read-only and safe. Execute mode can modify files and is confirmed + audited.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              {(['codex', 'claude'] as const).map((a) => {
                const ok = avail?.[a];
                const active = agent === a;
                const Icon = a === 'codex' ? Sparkles : Bot;
                return (
                  <button
                    key={a}
                    onClick={() => setAgent(a)}
                    className={`flex flex-1 items-center gap-2 rounded-lg border-2 px-3 py-2 text-sm transition-colors ${active ? 'border-zinc-900 bg-zinc-50' : 'border-zinc-200 hover:bg-zinc-50'}`}
                  >
                    <Icon className="size-4" />
                    <span className="font-medium">{AGENT_LABEL[a]}</span>
                    <Badge variant={ok ? 'default' : 'secondary'} className="ml-auto">
                      {avail == null ? '…' : ok ? 'ready' : 'missing'}
                    </Badge>
                  </button>
                );
              })}
            </div>

            <Textarea rows={6} value={task} onChange={(e) => setTask(e.target.value)} placeholder="Describe what the agent should do…" />

            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <ModeButton active={mode === 'plan'} onClick={() => setMode('plan')} icon={<ShieldCheck className="size-3.5" />} label="Plan (safe)" />
                <ModeButton active={mode === 'execute'} onClick={() => setMode('execute')} icon={<ShieldAlert className="size-3.5" />} label="Execute" danger />
              </div>
              <Button onClick={run} disabled={busy || (avail != null && !avail[agent])}>
                <Play /> {busy ? 'Running…' : `Run ${AGENT_LABEL[agent]}`}
              </Button>
            </div>
            {mode === 'execute' && <p className="text-destructive text-xs">Execute mode lets the agent modify files. It runs confirmed and audited.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Output</CardTitle>
            <CardDescription>{result ? `${AGENT_LABEL[result.agent]} · ${result.mode} · ${(result.durationMs / 1000).toFixed(1)}s` : 'Run an agent to see its output.'}</CardDescription>
          </CardHeader>
          <CardContent>
            {busy ? (
              <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">Running {AGENT_LABEL[agent]}…</div>
            ) : result ? (
              <pre className="bg-muted max-h-[60vh] overflow-auto rounded-md p-4 text-xs leading-relaxed whitespace-pre-wrap">{result.output || '(no output)'}</pre>
            ) : (
              <div className="text-muted-foreground flex h-64 items-center justify-center text-sm">No output yet.</div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Execute mode can modify files via the local AI CLI — require a typed confirmation. */}
      <Dialog open={confirming} onOpenChange={(o) => !o && !busy && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run {AGENT_LABEL[agent]} in execute mode</DialogTitle>
            <DialogDescription>
              Execute mode lets {AGENT_LABEL[agent]} modify files on this machine (workspace-write / acceptEdits). The run is audited.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm">
              Type <code className="bg-muted rounded px-1 py-0.5 font-mono text-xs">execute</code> to confirm:
            </p>
            <Input
              autoFocus
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="execute"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && confirmText === 'execute' && !busy) doRun(true);
              }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={() => doRun(true)} disabled={busy || confirmText !== 'execute'}>
              {busy ? 'Running…' : 'Run in execute mode'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModeButton(props: { active: boolean; onClick: () => void; icon: ReactNode; label: string; danger?: boolean }) {
  return (
    <button
      onClick={props.onClick}
      className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors ${
        props.active ? (props.danger ? 'border-destructive bg-destructive/10 text-destructive' : 'border-zinc-900 bg-zinc-50') : 'border-zinc-200 text-muted-foreground hover:bg-zinc-50'
      }`}
    >
      {props.icon}
      {props.label}
    </button>
  );
}
