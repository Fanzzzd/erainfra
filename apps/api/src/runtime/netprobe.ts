import { connect } from 'node:net';

// Real TCP connect-latency probe. Measures the actual time to establish a TCP handshake to
// host:port from THIS machine — a genuine measurement, not a modeled number. Used to back
// network.benchmark with real data when a target is reachable (e.g. a fabric peer's wgIp), and
// to honestly report "unreachable" otherwise instead of inventing a latency.

export interface ProbeResult {
  host: string;
  port: number;
  reachable: boolean;
  rttMs: number | null;
  error?: string;
}

export function tcpProbe(host: string, port: number, timeoutMs = 1500): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const sock = connect({ host, port });
    let done = false;
    const finish = (r: ProbeResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => {
      const rttMs = Number(process.hrtime.bigint() - start) / 1e6;
      finish({ host, port, reachable: true, rttMs: Math.round(rttMs * 100) / 100 });
    });
    sock.once('timeout', () => finish({ host, port, reachable: false, rttMs: null, error: `timeout after ${timeoutMs}ms` }));
    sock.once('error', (e) => finish({ host, port, reachable: false, rttMs: null, error: e.message }));
  });
}
