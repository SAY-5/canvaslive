import {
  apply,
  applyAll,
  type Color,
  type DocState,
  type Drawable,
  type Op,
  type Peer,
  type RoomId,
  type ServerMsg,
  type UserId,
} from "@canvaslive/shared";
import { TokenBucket } from "./rateLimit.js";
import type { Store } from "./store.js";

export interface ClientSession {
  wsId: string;
  userId: UserId;
  name: string;
  color: Color;
  send: (msg: ServerMsg) => void;
  close: (code: number, reason: string) => void;
  bucket: TokenBucket;
}

export class Room {
  readonly id: RoomId;
  state: DocState = new Map();
  lamport = 0;
  serverSeq = 0;
  private clients = new Map<string, ClientSession>();
  private pendingPersist: Op[] = [];
  private opsSinceSnapshot = 0;
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    id: RoomId,
    private readonly store: Store,
    private readonly snapshotEvery: number,
  ) {
    this.id = id;
  }

  hydrate(drawables: Drawable[], lamport: number, serverSeq: number, pending: Op[] = []): void {
    this.state = new Map(drawables.map((d) => [d.id, d]));
    this.lamport = lamport;
    this.serverSeq = serverSeq;
    if (pending.length > 0) {
      this.state = applyAll(this.state, pending);
      for (const op of pending) {
        this.lamport = Math.max(this.lamport, op.lamport);
        if (op.serverSeq !== undefined) {
          this.serverSeq = Math.max(this.serverSeq, op.serverSeq);
        }
      }
    }
  }

  addClient(session: ClientSession): Peer[] {
    this.clients.set(session.wsId, session);
    const peers: Peer[] = [];
    for (const c of this.clients.values()) {
      if (c.wsId === session.wsId) continue;
      peers.push({ userId: c.userId, name: c.name, color: c.color });
    }
    // Broadcast join
    const joinMsg: ServerMsg = {
      type: "peer",
      peer: { userId: session.userId, name: session.name, color: session.color },
      joined: true,
    };
    for (const c of this.clients.values()) {
      if (c.wsId !== session.wsId) c.send(joinMsg);
    }
    return peers;
  }

  removeClient(wsId: string): void {
    const session = this.clients.get(wsId);
    if (!session) return;
    this.clients.delete(wsId);
    const leaveMsg: ServerMsg = {
      type: "peer",
      peer: { userId: session.userId, name: session.name, color: session.color },
      joined: false,
    };
    for (const c of this.clients.values()) c.send(leaveMsg);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  snapshotDrawables(): Drawable[] {
    return Array.from(this.state.values());
  }

  /**
   * Apply a client op, assign a serverSeq, persist, and broadcast.
   * Returns the stamped op (or null if rejected).
   */
  submitOp(fromWsId: string, op: Op): Op | null {
    const session = this.clients.get(fromWsId);
    if (!session) return null;
    if (!session.bucket.tryConsume(1)) {
      session.send({ type: "error", code: "rate_limited", message: "too many ops" });
      return null;
    }

    // Stamp server-side metadata.
    this.lamport = Math.max(this.lamport, op.lamport) + 1;
    this.serverSeq += 1;
    const stamped: Op = { ...op, lamport: this.lamport, serverSeq: this.serverSeq };

    // Apply to state.
    this.state = apply(this.state, stamped);

    // Queue persistence.
    this.pendingPersist.push(stamped);
    this.opsSinceSnapshot += 1;
    this.schedulePersist();

    // Broadcast to everyone (including the originator, so they get authoritative
    // lamport/serverSeq).
    const msg: ServerMsg = { type: "op", op: stamped };
    for (const c of this.clients.values()) c.send(msg);

    return stamped;
  }

  relayCursor(fromWsId: string, x: number, y: number, visible: boolean): void {
    const sender = this.clients.get(fromWsId);
    if (!sender) return;
    const msg: ServerMsg = { type: "cursor", userId: sender.userId, x, y, visible };
    for (const c of this.clients.values()) {
      if (c.wsId !== fromWsId) c.send(msg);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, 50);
  }

  flush(): void {
    if (this.pendingPersist.length === 0) return;
    for (const op of this.pendingPersist) this.store.writeOp(this.id, op);
    this.pendingPersist = [];
    if (this.opsSinceSnapshot >= this.snapshotEvery) {
      this.store.writeSnapshot(this.id, this.lamport, this.serverSeq, this.state);
      this.opsSinceSnapshot = 0;
    }
  }

  shutdown(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.flush();
    // Final snapshot to capture latest state.
    this.store.writeSnapshot(this.id, this.lamport, this.serverSeq, this.state);
  }
}
