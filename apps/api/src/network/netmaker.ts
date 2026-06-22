import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MachineRole, NetworkPath, WireGuardPeer } from '../../../../packages/core/src/index.ts';

// Default fabric persist path. Hard-disabled under the node test runner so tests stay hermetic.
function persistDefault(envVar: string | undefined): string | undefined {
  return process.execArgv.includes('--test') ? undefined : envVar;
}
import {
  comparePaths,
  type EnrolledMachine,
  type EnrollMachineInput,
  type NetworkProvider,
} from './provider.ts';

// Deterministic WireGuard IP + container subnet allocator.
// ponytail: hosts 10.88.0.11–254 and subnets 10.210.1–254.0/24 cover ~244 machines.
// Widen to walk the /16 (10.88.X.Y) and 10.21X ranges when a fabric outgrows that.
export class Allocator {
  private freeHosts: number[];
  private freeSubnets: number[];
  constructor() {
    this.freeHosts = range(11, 254);
    this.freeSubnets = range(1, 254);
  }
  allocate(): { wgIp: string; containerSubnet: string; hostId: number; subnetId: number } {
    const hostId = this.freeHosts.shift();
    const subnetId = this.freeSubnets.shift();
    if (hostId === undefined || subnetId === undefined) throw new Error('network address pool exhausted');
    return { wgIp: `10.88.0.${hostId}`, containerSubnet: `10.210.${subnetId}.0/24`, hostId, subnetId };
  }
  // Idempotent: a double-release (e.g. racing revokes) must not create duplicate free slots,
  // or two later enrollments could be handed the same address. ponytail: linear scan, pool ≤244.
  release(hostId: number, subnetId: number): void {
    if (!this.freeHosts.includes(hostId)) this.freeHosts.unshift(hostId);
    if (!this.freeSubnets.includes(subnetId)) this.freeSubnets.unshift(subnetId);
  }
  // Mark an already-allocated slot as taken — used when restoring a persisted fabric on boot.
  reserve(hostId: number, subnetId: number): void {
    this.freeHosts = this.freeHosts.filter((h) => h !== hostId);
    this.freeSubnets = this.freeSubnets.filter((s) => s !== subnetId);
  }
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

// Minimal Netmaker control surface. The real provider talks to Netmaker's HTTP API;
// tests inject InMemoryNetmakerClient. The seam keeps Netmaker out of the control-plane core.
export interface NetmakerClient {
  createNode(input: { network: string; name: string; publicKey: string; address: string }): Promise<{ nodeId: string }>;
  deleteNode(nodeId: string): Promise<void>;
}

export class InMemoryNetmakerClient implements NetmakerClient {
  nodes = new Map<string, { name: string; publicKey: string; address: string }>();
  private seq = 0;
  async createNode(input: { network: string; name: string; publicKey: string; address: string }) {
    const nodeId = `nm-${++this.seq}`;
    this.nodes.set(nodeId, { name: input.name, publicKey: input.publicKey, address: input.address });
    return { nodeId };
  }
  async deleteNode(nodeId: string) {
    this.nodes.delete(nodeId);
  }
}

interface Entry {
  machine: EnrolledMachine;
  nodeId: string;
  hostId: number;
  subnetId: number;
}

export class NetmakerNetworkProvider implements NetworkProvider {
  private entries = new Map<string, Entry>();
  private paths = new Map<string, NetworkPath>(); // key: from|to
  private alloc = new Allocator();
  private seq = 0;
  private client: NetmakerClient;
  private network: string;
  private persistPath?: string;

  // persistPath defaults to PORTLESS_FABRIC_FILE (set at process start). Undefined => in-memory
  // only (tests stay hermetic). When set, the fabric is restored on boot + snapshotted on change.
  constructor(client: NetmakerClient, network = 'portless', persistPath: string | undefined = persistDefault(process.env.PORTLESS_FABRIC_FILE)) {
    this.client = client;
    this.network = network;
    this.persistPath = persistPath;
    this.loadPersisted();
  }

  private loadPersisted(): void {
    if (!this.persistPath || !existsSync(this.persistPath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { seq?: number; entries?: Entry[]; paths?: NetworkPath[] };
      this.seq = raw.seq ?? 0;
      for (const e of raw.entries ?? []) {
        this.entries.set(e.machine.id, e);
        this.alloc.reserve(e.hostId, e.subnetId); // re-take the slot so re-enroll can't collide
      }
      for (const p of raw.paths ?? []) this.paths.set(`${p.from}|${p.to}`, p);
    } catch (e) {
      console.error('[fabric] failed to load persisted fabric:', (e as Error).message);
    }
  }

  private snapshot(): void {
    if (!this.persistPath) return;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      // Atomic write (temp + rename): a crash mid-write must not corrupt the snapshot, which would
      // drop all reserved allocations and let a later enroll reuse an in-use WG IP.
      const tmp = `${this.persistPath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seq: this.seq, entries: [...this.entries.values()], paths: [...this.paths.values()] }, null, 2));
      renameSync(tmp, this.persistPath);
    } catch (e) {
      console.error('[fabric] failed to persist fabric:', (e as Error).message);
    }
  }

  async enrollMachine(input: EnrollMachineInput): Promise<EnrolledMachine> {
    const { wgIp, containerSubnet, hostId, subnetId } = this.alloc.allocate();
    try {
      const id = `m-${++this.seq}`;
      const { nodeId } = await this.client.createNode({
        network: this.network,
        name: input.name,
        publicKey: input.publicKey,
        address: wgIp,
      });
      const machine: EnrolledMachine = { id, ...input, wgIp, containerSubnet };
      this.entries.set(id, { machine, nodeId, hostId, subnetId });
      this.snapshot();
      return machine;
    } catch (err) {
      // The backend rejected the node — release the address so it isn't leaked out of the pool.
      this.alloc.release(hostId, subnetId);
      throw err;
    }
  }

  async revokeMachine(machineId: string): Promise<void> {
    const entry = this.entries.get(machineId);
    if (!entry) throw new Error(`unknown machine: ${machineId}`);
    // Claim the entry synchronously before the await so a concurrent revoke of the same id
    // can't read it too and double-release its address.
    this.entries.delete(machineId);
    try {
      await this.client.deleteNode(entry.nodeId);
    } catch (err) {
      this.entries.set(machineId, entry); // backend delete failed — put it back, address still in use
      throw err;
    }
    this.alloc.release(entry.hostId, entry.subnetId);
    // Drop fabric paths touching the revoked machine so the matrix can't surface stale topology.
    for (const [key, p] of this.paths) {
      if (p.from === machineId || p.to === machineId) this.paths.delete(key);
    }
    this.snapshot();
  }

  async rotateKey(machineId: string, newPublicKey: string): Promise<EnrolledMachine> {
    const entry = this.entries.get(machineId);
    if (!entry) throw new Error(`unknown machine: ${machineId}`);
    // Re-create the node with the new key, keeping the same address.
    await this.client.deleteNode(entry.nodeId);
    const { nodeId } = await this.client.createNode({
      network: this.network,
      name: entry.machine.name,
      publicKey: newPublicKey,
      address: entry.machine.wgIp,
    });
    entry.nodeId = nodeId;
    entry.machine = { ...entry.machine, publicKey: newPublicKey };
    this.snapshot();
    return entry.machine;
  }

  async setRoles(machineId: string, roles: MachineRole[]): Promise<EnrolledMachine> {
    const entry = this.entries.get(machineId);
    if (!entry) throw new Error(`unknown machine: ${machineId}`);
    entry.machine = { ...entry.machine, roles };
    this.snapshot();
    return entry.machine;
  }

  async listMachines(): Promise<EnrolledMachine[]> {
    return [...this.entries.values()].map((e) => e.machine);
  }

  async peersFor(machineId: string): Promise<WireGuardPeer[]> {
    if (!this.entries.has(machineId)) throw new Error(`unknown machine: ${machineId}`);
    const peers: WireGuardPeer[] = [];
    for (const [id, entry] of this.entries) {
      if (id === machineId) continue;
      const path = await this.bestPath(machineId, id);
      peers.push({
        machineId: id,
        publicKey: entry.machine.publicKey,
        endpoint: path?.endpoint,
        allowedIps: [`${entry.machine.wgIp}/32`, entry.machine.containerSubnet],
        persistentKeepalive: needsKeepalive(path?.kind) ? 25 : undefined,
      });
    }
    return peers;
  }

  async recordPath(path: NetworkPath): Promise<void> {
    const key = `${path.from}|${path.to}`;
    const existing = this.paths.get(key);
    if (!existing || comparePaths(path, existing) < 0) {
      this.paths.set(key, path);
      this.snapshot();
    }
  }

  async pathMatrix(): Promise<NetworkPath[]> {
    return [...this.paths.values()];
  }

  async bestPath(from: string, to: string): Promise<NetworkPath | undefined> {
    const candidates = [this.paths.get(`${from}|${to}`), this.paths.get(`${to}|${from}`)].filter(
      (p): p is NetworkPath => p !== undefined,
    );
    return candidates.sort(comparePaths)[0];
  }
}

function needsKeepalive(kind: NetworkPath['kind'] | undefined): boolean {
  return kind === 'nat-punched-direct' || kind === 'regional-relay' || kind === 'cloudflare-mesh-fallback';
}
