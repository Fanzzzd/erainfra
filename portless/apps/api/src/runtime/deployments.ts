// Deployment progress AND history, polled by the CLI/dashboard. Deploys run in the background (a
// build takes minutes; Cloudflare kills proxied requests at ~100s, so a synchronous deploy endpoint
// could never work through the tunnel) — the mutation returns a deployId immediately and this store
// tracks it. Persistent (SQLite): history survives restarts and is filterable per app; the last
// 1000 records are kept. In-flight deploys die with the process — failStale() marks them at boot.
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { db } from "../db.ts";

export type DeployStage =
  | "queued"
  | "reading-spec"
  | "building"
  | "deploying"
  | "linking"
  | "done"
  | "failed";

export interface Deployment {
  id: string;
  app: string;
  stage: DeployStage;
  detail: string; // human line for the current stage, e.g. "building web (2/3)"
  urls: string[];
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

const KEEP = 1000;

interface Row {
  id: string;
  app: string;
  stage: string;
  detail: string;
  urls: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

const toDep = (r: Row): Deployment => ({
  id: r.id,
  app: r.app,
  stage: r.stage as DeployStage,
  detail: r.detail,
  urls: JSON.parse(r.urls) as string[],
  error: r.error ?? undefined,
  startedAt: r.started_at,
  finishedAt: r.finished_at ?? undefined,
});

export class DeploymentStore {
  private d: DatabaseSync;

  constructor(d: DatabaseSync = db) {
    this.d = d;
  }

  create(app: string): Deployment {
    const dep: Deployment = {
      id: randomUUID(),
      app,
      stage: "queued",
      detail: "queued",
      urls: [],
      startedAt: new Date().toISOString(),
    };
    this.d
      .prepare(
        "INSERT INTO deployments (id, app, stage, detail, urls, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(dep.id, dep.app, dep.stage, dep.detail, "[]", dep.startedAt);
    this.d
      .prepare(
        `DELETE FROM deployments WHERE rowid NOT IN (SELECT rowid FROM deployments ORDER BY rowid DESC LIMIT ${KEEP})`,
      )
      .run();
    return dep;
  }

  update(
    id: string,
    patch: Partial<Pick<Deployment, "stage" | "detail" | "urls" | "error">>,
  ): void {
    const cur = this.get(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    const finished =
      patch.stage === "done" || patch.stage === "failed"
        ? new Date().toISOString()
        : (cur.finishedAt ?? null);
    this.d
      .prepare(
        "UPDATE deployments SET stage = ?, detail = ?, urls = ?, error = ?, finished_at = ? WHERE id = ?",
      )
      .run(next.stage, next.detail, JSON.stringify(next.urls), next.error ?? null, finished, id);
  }

  get(id: string): Deployment | undefined {
    const r = this.d.prepare("SELECT * FROM deployments WHERE id = ?").get(id) as Row | undefined;
    return r && toDep(r);
  }

  // Most recent first; optionally filtered to one app.
  list(limit = 20, app?: string): Deployment[] {
    const rows = app
      ? this.d
          .prepare("SELECT * FROM deployments WHERE app = ? ORDER BY rowid DESC LIMIT ?")
          .all(app, limit)
      : this.d.prepare("SELECT * FROM deployments ORDER BY rowid DESC LIMIT ?").all(limit);
    return (rows as unknown as Row[]).map(toDep);
  }

  // A hub restart kills in-flight pipelines; mark their records so pollers see a terminal state.
  failStale(reason: string): number {
    return Number(
      this.d
        .prepare(
          "UPDATE deployments SET stage = 'failed', error = ?, finished_at = ? WHERE stage NOT IN ('done', 'failed')",
        )
        .run(reason, new Date().toISOString()).changes,
    );
  }
}

export const deployments = new DeploymentStore();
