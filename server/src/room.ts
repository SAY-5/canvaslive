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
  private opsSinceSnapshot = 0;

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

    // Validate incoming op size — frame-level maxPayload already caps the
    // raw bytes, but inside a valid frame a single op can still declare an
    // oversized points/text/href. Reject early and tell the client.
    const validation = validateOpSize(op);
    if (!validation.ok) {
      session.send({ type: "error", code: "op_too_large", message: validation.reason });
      return null;
    }

    // Stamp server-side metadata.
    this.lamport = Math.max(this.lamport, op.lamport) + 1;
    this.serverSeq += 1;
    const stamped: Op = { ...op, lamport: this.lamport, serverSeq: this.serverSeq };

    // Apply to state.
    this.state = apply(this.state, stamped);

    // Persist synchronously BEFORE broadcasting. If the process crashes
    // between broadcast and persist, clients would have applied an op
    // that's absent from the durable log, causing permanent divergence
    // on reconnect. WAL-mode SQLite makes the row insert cheap.
    this.store.writeOp(this.id, stamped);
    this.opsSinceSnapshot += 1;
    if (this.opsSinceSnapshot >= this.snapshotEvery) {
      this.store.writeSnapshot(this.id, this.lamport, this.serverSeq, this.state);
      this.opsSinceSnapshot = 0;
    }

    // Broadcast to everyone (including the originator, so they get
    // authoritative lamport/serverSeq).
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

  /** No-op: kept for API compatibility. Ops are persisted synchronously. */
  flush(): void {
    // intentionally empty
  }

  shutdown(): void {
    // Final snapshot to capture latest in-memory state.
    this.store.writeSnapshot(this.id, this.lamport, this.serverSeq, this.state);
  }
}

// ---------------------------------------------------------------------------
// Op validation caps
// ---------------------------------------------------------------------------

const MAX_STROKE_POINTS = 20_000;
const MAX_APPEND_POINTS = 2_000;
const MAX_TEXT_LEN = 10_000;
const MAX_HREF_LEN = 500_000; // data: URLs for images up to ~500KB
const MAX_FONT_LEN = 200;
const MAX_COLOR_LEN = 16;

function validateOpSize(op: Op): { ok: true } | { ok: false; reason: string } {
  if (op.type === "add") {
    const s = op.shape as unknown as Record<string, unknown>;
    if (s.kind === "stroke") {
      const pts = (s.points as unknown[]) ?? [];
      if (pts.length > MAX_STROKE_POINTS) {
        return { ok: false, reason: `stroke points exceed ${MAX_STROKE_POINTS}` };
      }
    }
    if (s.kind === "text" && typeof s.text === "string" && s.text.length > MAX_TEXT_LEN) {
      return { ok: false, reason: `text exceeds ${MAX_TEXT_LEN} chars` };
    }
    if (typeof s.font === "string" && s.font.length > MAX_FONT_LEN) {
      return { ok: false, reason: "font name too long" };
    }
    if (s.kind === "image" && typeof s.href === "string" && s.href.length > MAX_HREF_LEN) {
      return { ok: false, reason: `image href exceeds ${MAX_HREF_LEN} chars` };
    }
    for (const key of ["color", "stroke", "fill"] as const) {
      const v = s[key];
      if (typeof v === "string" && v.length > MAX_COLOR_LEN) {
        return { ok: false, reason: `${key} too long` };
      }
    }
  }
  if (op.type === "patch") {
    const patch = op.patch as Record<string, unknown>;
    const pts = patch.points as { $append?: unknown[] } | undefined;
    if (pts && Array.isArray(pts.$append) && pts.$append.length > MAX_APPEND_POINTS) {
      return { ok: false, reason: `patch $append exceeds ${MAX_APPEND_POINTS}` };
    }
    if (typeof patch.text === "string" && patch.text.length > MAX_TEXT_LEN) {
      return { ok: false, reason: `text exceeds ${MAX_TEXT_LEN} chars` };
    }
    if (typeof patch.href === "string" && patch.href.length > MAX_HREF_LEN) {
      return { ok: false, reason: `href exceeds ${MAX_HREF_LEN} chars` };
    }
  }
  return { ok: true };
}
