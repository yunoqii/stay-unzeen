import { randomBytes } from "node:crypto";
import { actionNotBefore, cryptoRng, type ActionJitter, type Rng } from "./random";
import { LeaseLostError, type ClaimedJob, type ExecMode, type Job, type JobQueue, type JobResult, type JobSpec, type Lane, type SentAttempt } from "./types";

type State = "queued" | "executed" | "failed";

interface Row extends Job {
  state: State;
  execMode: ExecMode;
  leaseId: string | null;
  leaseUntil: number;
  result: JobResult | null;
}

export interface JobSnapshot extends Job {
  state: State;
  result: JobResult | null;
}

/**
 * Process-local queue for tests and the devnet script. Same semantics as the
 * Postgres queue: leases, claims counter, attempts recorded before broadcast.
 */
export class InMemoryJobQueue implements JobQueue {
  private readonly rows = new Map<string, Row>();

  constructor(
    private readonly rng: Rng = cryptoRng,
    private readonly jitter?: ActionJitter,
  ) {}

  /**
   * Adds a job. Without `notBefore` a random action delay is applied
   * (API.md: epoch 3–10 s + 0–20 s jitter).
   */
  enqueue(spec: JobSpec, opts: { notBefore?: number; now?: number; id?: string; execMode?: ExecMode } = {}): JobSnapshot {
    const now = opts.now ?? Date.now();
    const id = opts.id ?? randomBytes(16).toString("hex");
    if (this.rows.has(id)) throw new Error("duplicate job id");
    const row: Row = {
      id,
      spec,
      notBefore: opts.notBefore ?? actionNotBefore(now, this.rng, this.jitter),
      claims: 0,
      attempts: [],
      state: "queued",
      execMode: opts.execMode ?? "delayed",
      leaseId: null,
      leaseUntil: 0,
      result: null,
    };
    this.rows.set(id, row);
    return snapshot(row);
  }

  /**
   * Same order as the Postgres queue: earliest `notBefore`; ties (one epoch)
   * in random order for the batch lane, FIFO for the now / attest lanes.
   * Attest jobs only in the attest lane (fair first) or, without a lane, first.
   */
  async claim(opts: { workerId: string; now: number; leaseMs: number; lane?: Lane }): Promise<ClaimedJob | null> {
    let due: Row[] = [];
    // Priority class (lower first): attest lane -> fair before verify; no lane -> attest first.
    const cls = (r: Row): number => {
      if (opts.lane === "attest") return r.spec.kind === "attest" && r.spec.purpose === "verify" ? 1 : 0;
      if (opts.lane === undefined) return r.spec.kind === "attest" ? 0 : 1;
      return 0;
    };
    for (const r of this.rows.values()) {
      if (r.state !== "queued" || r.notBefore > opts.now) continue;
      if (r.leaseId !== null && r.leaseUntil > opts.now) continue;
      const attest = r.spec.kind === "attest";
      if (opts.lane === "attest" && !attest) continue;
      if ((opts.lane === "now" || opts.lane === "batch") && (attest || (opts.lane === "now") !== (r.execMode === "now"))) continue;
      const head = due[0];
      if (!head || cls(r) < cls(head) || (cls(r) === cls(head) && r.notBefore < head.notBefore)) due = [r];
      else if (cls(r) === cls(head) && r.notBefore === head.notBefore) due.push(r);
    }
    if (due.length === 0) return null;
    const best = opts.lane === "now" || opts.lane === "attest" ? due[0]! : due[this.rng.int(0, due.length - 1)]!;
    best.leaseId = randomBytes(8).toString("hex");
    best.leaseUntil = opts.now + opts.leaseMs;
    best.claims += 1;
    return { ...copyJob(best), leaseId: best.leaseId, leaseUntil: best.leaseUntil };
  }

  async reportSent(job: { id: string; leaseId: string }, attempt: SentAttempt): Promise<void> {
    const r = this.leased(job);
    r.attempts.push({ ...attempt });
  }

  async reportResult(job: { id: string; leaseId: string }, result: JobResult): Promise<void> {
    const r = this.leased(job);
    r.leaseId = null;
    r.leaseUntil = 0;
    r.result = result;
    if (result.status === "retry") {
      r.state = "queued";
      r.notBefore = result.notBefore;
    } else {
      r.state = result.status;
    }
  }

  get(id: string): JobSnapshot | undefined {
    const r = this.rows.get(id);
    return r ? snapshot(r) : undefined;
  }

  all(): JobSnapshot[] {
    return [...this.rows.values()].map(snapshot);
  }

  /** Earliest `notBefore` among queued jobs (for idle sleeping), or null. */
  nextDue(): number | null {
    let t: number | null = null;
    for (const r of this.rows.values()) {
      if (r.state === "queued" && (t === null || r.notBefore < t)) t = r.notBefore;
    }
    return t;
  }

  /** Test hook: simulates a crashed worker whose lease ran out. */
  expireLease(id: string): void {
    const r = this.rows.get(id);
    if (r) r.leaseUntil = 0;
  }

  private leased(job: { id: string; leaseId: string }): Row {
    const r = this.rows.get(job.id);
    if (!r || r.leaseId !== job.leaseId || r.state !== "queued") throw new LeaseLostError(job.id);
    return r;
  }
}

function copyJob(r: Row): Job {
  return { id: r.id, spec: r.spec, notBefore: r.notBefore, claims: r.claims, attempts: r.attempts.map((a) => ({ ...a })) };
}

function snapshot(r: Row): JobSnapshot {
  return { ...copyJob(r), state: r.state, result: r.result };
}
