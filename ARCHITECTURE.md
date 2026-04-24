# CanvasLive Architecture

## Overview

CanvasLive is a real-time multiplayer whiteboard. Multiple users in the same
room see each other's drawing strokes and cursor positions live, with
operational-transform (OT) conflict resolution ensuring all clients converge on
the same document state regardless of latency or network reordering.

The system is three pieces:

| Piece   | Stack                       | Responsibility                                            |
|---------|-----------------------------|-----------------------------------------------------------|
| shared  | TypeScript                  | Document model, op types, transform/compose, protocol     |
| server  | Node.js + `ws`              | Rooms, sequencing, persistence (SQLite), presence relay   |
| client  | React 18 + Vite             | Rendering, input, OT client, cursors, export              |

The shared package is published as an internal workspace so server and client
share the *exact same* OT code — a non-negotiable property for correctness.

## Document model

The document is a keyed set of **drawables**. Each drawable has a stable id
(nanoid) and is one of:

```
Stroke      { id, kind: "stroke",    points: [{x,y,pressure}], color, width }
Rect        { id, kind: "rect",      x, y, w, h, stroke, fill, strokeWidth }
Ellipse     { id, kind: "ellipse",   cx, cy, rx, ry, stroke, fill, strokeWidth }
Line        { id, kind: "line",      x1, y1, x2, y2, stroke, strokeWidth }
Text        { id, kind: "text",      x, y, text, font, size, color }
Image       { id, kind: "image",     x, y, w, h, href }        # data: URL or blob ref
```

Drawables carry `z` (integer layer index) and `createdBy` (user id), `createdAt`
(Lamport time), and `updatedAt` (Lamport time).

State is `Map<id, Drawable>` — a CRDT-friendly shape. Rendering order is by `z`
then `createdAt` for ties.

## Operations

Three operation types:

```
OpAdd     { type: "add",    id, shape: Drawable }
OpRemove  { type: "remove", id }
OpPatch   { type: "patch",  id, patch: Partial<Drawable> }
```

Every op carries `{ clientId, clientSeq, lamport }`. The server stamps a
`serverSeq` on acceptance.

### Why OT, not plain CRDT?

For drawables this specific, a plain LWW-map CRDT actually works. But:
- We want *intention preservation* for stroke edits (e.g. two users adjusting
  the same shape's position should accumulate, not clobber).
- OT handles that via field-wise merge in `transform`.

Each op is idempotent when applied twice, and transform is defined for every
concurrent pair.

### Transform rules

For concurrent ops `a` and `b` (neither observes the other):

| a        | b        | transform(a, b) → a'                                  |
|----------|----------|-------------------------------------------------------|
| add id1  | add id2  | a unchanged (different ids by construction)           |
| add id   | add id   | *impossible* — ids are client-unique nanoids          |
| remove   | remove   | if same id: a becomes noop; else unchanged            |
| remove   | patch    | if same id: a wins; patch becomes noop                |
| patch    | remove   | if same id: a becomes noop                            |
| patch    | patch    | if same id: field-wise; b's fields that overlap a's   |
|          |          | fields drop from a iff b.lamport > a.lamport          |
| add      | remove   | if same id: remove becomes noop (nothing to remove)   |
| add      | patch    | if same id: patch becomes noop (shape not yet visible)|

A *noop* is encoded as a sentinel op with `type: "noop"` — kept in the sequence
so Lamport clocks stay in sync.

### Compose

`compose(a, b)` merges two sequential ops into one when possible. Used for
coalescing stroke point-appends on the client before send:

- `patch(id, p1) + patch(id, p2)` → `patch(id, {...p1, ...p2})`

Stroke points are appended via `patch({ points: { $append: [...] } })`, with a
JSON-patch-ish sub-op that compose turns into a single batched append.

## Protocol

WebSocket framing is one JSON message per frame.

### Client → Server

```
{ type: "hello", token?, roomId, name, color }
{ type: "op",    op: Op, clientSeq }
{ type: "cursor", x, y, visible }
{ type: "ack",   serverSeq }           # flow control
{ type: "ping",  t }
```

### Server → Client

```
{ type: "welcome", userId, roomId, snapshot: {drawables}, lamport, serverSeq, peers: [Peer] }
{ type: "op",      op: Op, serverSeq, lamport }
{ type: "cursor",  userId, x, y, visible }
{ type: "peer",    userId, name, color, joined?: bool }
{ type: "error",   code, message }
{ type: "pong",    t }
```

`welcome` delivers an immediate snapshot; thereafter only deltas. `ack`
from client lets the server drop buffered ops older than the ack'd seq for
that client (back-pressure).

## Server

### Room lifecycle

- Rooms are keyed by UUIDv4 path segment (`/ws/room/:id`).
- A room is created lazily on first connection and persisted to SQLite.
- Rooms idle with no connections for >30min are marked cold — state stays in
  SQLite, in-memory copy is evicted.

### Concurrency model

One `Room` object per live room, owning:
- `state: Map<id, Drawable>`
- `clients: Map<wsId, ClientSession>`
- `lamport: number`
- `serverSeq: number`
- `pendingPersist: Op[]`  # batched WAL

All mutation goes through `Room.apply(op)` which is synchronous per-room.
The server is single-process; room objects never cross event loop ticks
mid-mutation, so no locks are needed.

### Persistence

SQLite via `better-sqlite3`. Schema:

```sql
CREATE TABLE rooms (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  last_active   INTEGER NOT NULL,
  lamport       INTEGER NOT NULL,
  server_seq    INTEGER NOT NULL,
  snapshot_json TEXT    NOT NULL    -- gzipped JSON
);

CREATE TABLE ops (
  room_id    TEXT NOT NULL,
  server_seq INTEGER NOT NULL,
  op_json    TEXT NOT NULL,
  PRIMARY KEY (room_id, server_seq)
);

CREATE INDEX idx_ops_room ON ops(room_id, server_seq);
```

Write strategy:
- Every accepted op is appended to `ops` synchronously (batched every 50ms).
- Snapshot is rewritten every 500 ops or every 5 minutes, whichever first.
- On startup / room reload, latest snapshot is loaded then `ops` with
  `server_seq > snapshot.server_seq` are replayed.

### Auth

Two modes:
1. **Anonymous** — server issues a signed JWT with a generated user id.
2. **Token** — client presents a pre-issued JWT (external auth integration).

JWT secret via `CANVASLIVE_JWT_SECRET` env var. Rooms can optionally be
configured as private (requires token with `rooms:rw:<roomId>` claim).

### Rate limiting

Token bucket per client: 200 ops/sec refill, burst 400. Violations get a
warning frame; continued violations trigger disconnect.

### Presence

Cursors are relayed but never persisted. Throttled server-side to 30Hz per
sender. Dead clients (no messages for 45s) time out.

## Client

### Rendering

Canvas 2D for strokes (fast for many stroke paths), SVG overlay for shapes
(crisp at any zoom), DOM layer for cursors + text inputs.

Infinite canvas via viewport transform: `translate(tx, ty) scale(s)`. Pan
with space+drag or middle-mouse. Zoom with ctrl/cmd+scroll. Fit-to-content
keyboard shortcut.

### OT client

`OTClient` maintains:
- `serverState: Map<id, Drawable>` — last known server state
- `pending: Op[]` — ops sent but not yet acknowledged
- `local: Map<id, Drawable>` — render target = apply(serverState, pending)

On local op: push to pending, send to server, update local.
On remote op from server:
  1. Transform remote against each op in `pending` → `remote'`
  2. Apply `remote'` to `serverState`
  3. Rebuild `local` from `serverState + pending`
On ack: drop ops from `pending` with `clientSeq <= ack.clientSeq`.

### Tools

- **Select** — click to select, shift-click for multi, drag to move, handles to resize.
- **Pen** — freehand stroke with pressure support (`PointerEvent.pressure`).
- **Rectangle / Ellipse / Line** — click-drag.
- **Text** — click to place, inline contentEditable, commit on blur.
- **Image** — drop/paste image file → uploaded as data URL (≤500KB) or via server blob upload.
- **Eyedropper** — pick color from any drawable.

Keyboard shortcuts match Figma's: V/P/R/E/L/T/I for tools, cmd-z/y for
undo/redo, cmd-d to duplicate, del/backspace to delete.

### Undo/redo

Per-user history. An undo emits the *inverse* op(s) as new ops (no magic
server-side undo queue). If a remote user has since removed your shape, your
undo-of-remove becomes a noop (remove of absent id).

### Export

- PNG: rasterize canvas viewport at configurable DPI.
- SVG: serialize all drawables into one SVG document.
- JSON: raw document snapshot.

## Testing

- **shared/** — Jest unit tests for transform, compose, apply. Property tests
  via `fast-check`: for all concurrent op pairs `(a, b)`,
  `apply(apply(s, a), transform(b, a)) == apply(apply(s, b), transform(a, b))`
  (the TP1 property).
- **server/** — Integration tests: spawn server, drive two `ws` clients, verify
  convergence after randomized op interleaving.
- **client/** — Vitest component tests for tool state machines + OT client.

Target coverage: 90% on `shared/`, 80% on server, 70% on client.

## CI

`.github/workflows/ci.yml`:
- Matrix: Node 20 + 22
- `npm ci`, `npm run build`, `npm test`
- Upload coverage to Codecov

## Non-goals (documented to prevent scope creep)

- No video/voice — out of scope.
- No real-time collaborative text editing beyond whole-text-field replace.
- No mobile-native app — web only (responsive-ish).
- No plug-in system — that's PluginForge's job.
