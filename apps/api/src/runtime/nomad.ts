// Nomad provider. The control plane talks to this interface; MockNomadProvider backs
// tests and the real one (M10) renders NomadJobSpec -> HCL (core.renderNomadJob) and
// POSTs to the Nomad HTTP API. We do NOT build a custom scheduler.

export interface NomadJobSpec {
  id: string;
  replicas: number;
  image: string;
  healthPath?: string;
}

export type AllocStatus = 'pending' | 'running' | 'failed' | 'complete';

export interface NomadAllocation {
  id: string;
  jobId: string;
  status: AllocStatus;
  healthy: boolean;
  nodeId: string;
}

export interface NomadProvider {
  submitJob(job: NomadJobSpec): Promise<{ allocations: NomadAllocation[] }>;
  jobStatus(jobId: string): Promise<{ jobId: string; allocations: NomadAllocation[] }>;
  allocLogs(allocId: string, lines?: number): Promise<string[]>;
  stopJob(jobId: string): Promise<void>;
}

// Map Nomad allocations to a single deployment status.
export function deploymentStatus(allocs: NomadAllocation[]): 'pending' | 'healthy' | 'failed' {
  if (allocs.length === 0) return 'pending';
  if (allocs.some((a) => a.status === 'failed' || (a.status === 'running' && !a.healthy))) return 'failed';
  if (allocs.every((a) => a.status === 'running' && a.healthy)) return 'healthy';
  return 'pending';
}

// Deterministic in-memory Nomad. Spreads allocs across mock nodes (unique-machine
// placement) and marks them unhealthy when the image is in failImages (broken release).
export class MockNomadProvider implements NomadProvider {
  failImages = new Set<string>();
  private jobs = new Map<string, NomadAllocation[]>();
  private seq = 0;

  async submitJob(job: NomadJobSpec): Promise<{ allocations: NomadAllocation[] }> {
    const healthy = !this.failImages.has(job.image);
    const allocations: NomadAllocation[] = Array.from({ length: job.replicas }, (_, i) => ({
      id: `alloc-${++this.seq}`,
      jobId: job.id,
      status: healthy ? 'running' : 'failed',
      healthy,
      nodeId: `node-${i + 1}`, // unique node per replica
    }));
    this.jobs.set(job.id, allocations);
    return { allocations };
  }

  async jobStatus(jobId: string): Promise<{ jobId: string; allocations: NomadAllocation[] }> {
    return { jobId, allocations: this.jobs.get(jobId) ?? [] };
  }

  async allocLogs(allocId: string, lines = 100): Promise<string[]> {
    return [`[mock] ${lines} log lines for ${allocId}`];
  }

  async stopJob(jobId: string): Promise<void> {
    this.jobs.delete(jobId);
  }
}
