import { createRequire } from "node:module";
import { gzipSync, gunzipSync } from "node:zlib";
import type { Drawable, DrawableId, Op, RoomId } from "@canvaslive/shared";

// Use createRequire so Vite/vitest doesn't try to resolve "node:sqlite" at
// bundle time — it gets loaded as a real Node builtin at runtime.
const nodeRequire = createRequire(import.meta.url);
const sqlite = nodeRequire("node:sqlite") as typeof import("node:sqlite");
const { DatabaseSync } = sqlite;
type DatabaseSync = import("node:sqlite").DatabaseSync;
type StatementSync = import("node:sqlite").StatementSync;

export interface RoomSnapshot {
  roomId: RoomId;
  lamport: number;
  serverSeq: number;
  drawables: Drawable[];
  lastActive: number;
  pendingOps?: Op[];
}

export class Store {
  private readonly db: DatabaseSync;
  private readonly insertRoom: StatementSync;
  private readonly updateRoom: StatementSync;
  private readonly loadRoom: StatementSync;
  private readonly insertOp: StatementSync;
  private readonly loadOpsSince: StatementSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec(SCHEMA);
    this.insertRoom = this.db.prepare(
      `INSERT INTO rooms(id, created_at, last_active, lamport, server_seq, snapshot_blob)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    );
    this.updateRoom = this.db.prepare(
      `UPDATE rooms
         SET last_active = ?, lamport = ?, server_seq = ?, snapshot_blob = ?
       WHERE id = ?`,
    );
    this.loadRoom = this.db.prepare(
      `SELECT id, lamport, server_seq, snapshot_blob, last_active
         FROM rooms WHERE id = ?`,
    );
    this.insertOp = this.db.prepare(
      `INSERT INTO ops(room_id, server_seq, op_json) VALUES(?, ?, ?)`,
    );
    this.loadOpsSince = this.db.prepare(
      `SELECT op_json FROM ops WHERE room_id = ? AND server_seq > ? ORDER BY server_seq`,
    );
  }

  close(): void {
    this.db.close();
  }

  ensureRoom(roomId: RoomId): void {
    const now = Date.now();
    const empty = gzipSync(JSON.stringify([]));
    // node:sqlite requires Uint8Array for blob columns.
    this.insertRoom.run(
      roomId,
      now,
      now,
      0,
      0,
      new Uint8Array(empty.buffer, empty.byteOffset, empty.byteLength),
    );
  }

  loadSnapshot(roomId: RoomId): RoomSnapshot | null {
    const row = this.loadRoom.get(roomId) as
      | {
          id: string;
          lamport: number;
          server_seq: number;
          snapshot_blob: Uint8Array;
          last_active: number;
        }
      | undefined;
    if (!row) return null;
    const drawables = JSON.parse(
      gunzipSync(Buffer.from(row.snapshot_blob)).toString("utf8"),
    ) as Drawable[];
    const snap: RoomSnapshot = {
      roomId: row.id,
      lamport: row.lamport,
      serverSeq: row.server_seq,
      drawables,
      lastActive: row.last_active,
    };
    const opsRows = this.loadOpsSince.all(roomId, row.server_seq) as Array<{
      op_json: string;
    }>;
    if (opsRows.length > 0) {
      snap.pendingOps = opsRows.map((r) => JSON.parse(r.op_json) as Op);
    }
    return snap;
  }

  writeOp(roomId: RoomId, op: Op): void {
    if (op.serverSeq === undefined) {
      throw new Error("writeOp requires op.serverSeq");
    }
    this.insertOp.run(roomId, op.serverSeq, JSON.stringify(op));
  }

  writeSnapshot(
    roomId: RoomId,
    lamport: number,
    serverSeq: number,
    drawables: Map<DrawableId, Drawable>,
  ): void {
    const arr = Array.from(drawables.values());
    const blob = gzipSync(JSON.stringify(arr));
    this.updateRoom.run(
      Date.now(),
      lamport,
      serverSeq,
      new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength),
      roomId,
    );
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL,
  lamport       INTEGER NOT NULL,
  server_seq    INTEGER NOT NULL,
  snapshot_blob BLOB    NOT NULL
);

CREATE TABLE IF NOT EXISTS ops (
  room_id    TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  op_json    TEXT NOT NULL,
  PRIMARY KEY (room_id, server_seq)
);

CREATE INDEX IF NOT EXISTS idx_ops_room ON ops(room_id, server_seq);
`;
