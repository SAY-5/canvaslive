import {
  apply,
  applyAll,
  transform,
  type DocState,
  type Op,
  type ServerMsg,
  type UserId,
} from "@canvaslive/shared";

/**
 * Client-side OT buffer.
 *
 * Usage:
 *   const ot = new OTClient(userId, () => { state = ot.local; rerender(); });
 *   ot.onWelcome(msg);
 *   ws.onmessage = (ev) => ot.onServerMsg(JSON.parse(ev.data));
 *
 * Local edits:
 *   const op = ot.localOp({ type: "add", id, shape, ... });
 *   ws.send(JSON.stringify({ type: "op", op }));
 */
export class OTClient {
  /** Authoritative server state as we last saw it. */
  serverState: DocState = new Map();
  /** Local ops sent-but-not-ack'd. Applied on top of server to form local. */
  pending: Op[] = [];
  /** Composite render target. */
  local: DocState = new Map();

  lamport = 0;
  private clientSeq = 0;

  constructor(
    public readonly userId: UserId,
    private readonly onChange: () => void,
  ) {}

  /** Stamp a nascent op with the next client seq + lamport, record it, return it. */
  localOp<T extends Op>(op: Omit<T, "clientId" | "clientSeq" | "lamport"> & Partial<Pick<Op, "clientId" | "clientSeq" | "lamport">>): T {
    this.lamport += 1;
    this.clientSeq += 1;
    const stamped = {
      ...op,
      clientId: this.userId,
      clientSeq: this.clientSeq,
      lamport: this.lamport,
    } as T;
    this.pending.push(stamped);
    this.recomputeLocal();
    this.onChange();
    return stamped;
  }

  onWelcome(snapshot: DocState, lamport: number): void {
    this.serverState = new Map(snapshot);
    this.lamport = lamport;
    this.pending = [];
    this.recomputeLocal();
    this.onChange();
  }

  /** Handle an incoming server op. Returns true if the op was our own echo. */
  onServerOp(op: Op): boolean {
    this.lamport = Math.max(this.lamport, op.lamport);
    if (op.clientId === this.userId) {
      // Echo of our own op. Drop any pending entries with seq <= this clientSeq.
      this.pending = this.pending.filter((p) => p.clientSeq > op.clientSeq);
      // Apply the authoritative (possibly lamport-bumped) version to serverState.
      this.serverState = apply(this.serverState, op);
      this.recomputeLocal();
      this.onChange();
      return true;
    }
    // Remote op: walk the pending queue once, maintaining both the
    // progressively-rebased remote and the progressively-rebased pending
    // entries. For each local `p_i`:
    //   rebasedLocal_i = transform(p_i, accumulatedRemote)
    //   accumulatedRemote = transform(accumulatedRemote, p_i)
    // so subsequent p_{i+1} is rebased against the remote *after* p_i has
    // been accounted for, which is what TP1 requires with > 1 pending op.
    let accumulatedRemote: Op = op;
    const rebasedPending: Op[] = [];
    for (const local of this.pending) {
      const rebasedLocal = transform(local, accumulatedRemote);
      accumulatedRemote = transform(accumulatedRemote, local);
      rebasedPending.push(rebasedLocal);
    }
    this.pending = rebasedPending;
    this.serverState = apply(this.serverState, accumulatedRemote);
    this.recomputeLocal();
    this.onChange();
    return false;
  }

  private recomputeLocal(): void {
    this.local = applyAll(this.serverState, this.pending);
  }
}

export function parseServerMsg(data: string): ServerMsg | null {
  try {
    return JSON.parse(data) as ServerMsg;
  } catch {
    return null;
  }
}
