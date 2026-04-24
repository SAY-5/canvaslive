# CanvasLive

[![ci](https://github.com/SAY-5/canvaslive/actions/workflows/ci.yml/badge.svg)](https://github.com/SAY-5/canvaslive/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)](#)
[![node](https://img.shields.io/badge/node-22+-339933)](#)

Real-time multiplayer whiteboard with WebSocket-based live cursors and
operational-transform conflict resolution.

- **Shared OT engine** with 500-run property test proving TP1 convergence.
- **Node server** with per-room sequencing, SQLite persistence, JWT auth,
  and per-client token-bucket rate limiting.
- **React client** with freehand strokes, shapes, text, infinite canvas
  (pan/zoom), live cursors, and keyboard shortcuts.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the design writeup (document
model, transform rules, protocol, persistence, security).

## Quick start

Requires Node 22+ (the server uses the built-in `node:sqlite` module).

```bash
npm install
npm run build
npm run dev     # starts server on :8787 and client on :5173
```

Open http://localhost:5173. Pick a name and color, enter a room id. Open
the same URL in another window to see the other session's strokes and
cursor in real time.

## Scripts

| Command                 | What it does                                    |
|-------------------------|-------------------------------------------------|
| `npm run build`         | Build `shared`, `server`, and `client`          |
| `npm run dev`           | Run all three in watch mode (concurrently)      |
| `npm test`              | Run OT + server integration tests               |
| `npm -w shared run test`| OT engine tests (16 tests, 500 property runs)   |
| `npm -w server run test`| Integration tests: handshake, convergence, persist |
| `npm -w client run test`| OT client rebase tests                          |
| `npm run lint`          | Type-check all three packages                   |

## Server configuration

Set via env vars:

| Var                             | Default        | Notes                                   |
|---------------------------------|----------------|-----------------------------------------|
| `PORT`                          | 8787           |                                         |
| `HOST`                          | 0.0.0.0        |                                         |
| `CANVASLIVE_DB`                 | ./canvaslive.db|                                         |
| `CANVASLIVE_JWT_SECRET`         | — (required in prod) | Min 16 chars                     |
| `CANVASLIVE_JWT_SECRET_FILE`    | —              | Alternative to inline secret            |
| `CANVASLIVE_REQUIRE_AUTH`       | 0              | If 1, clients must send a valid token   |
| `CANVASLIVE_MAX_OPS_PER_SEC`    | 200            | Per-client rate limit                   |
| `CANVASLIVE_MAX_BURST`          | 400            |                                         |
| `CANVASLIVE_SNAPSHOT_EVERY`     | 500 ops        | Op count between state snapshots        |
| `CANVASLIVE_CORS_ORIGINS`       | `*`            | Comma-separated, or `*` for any         |
| `CANVASLIVE_MAX_MSG_BYTES`      | 262144         | WS frame size cap                       |

## Protocol

See [ARCHITECTURE.md#protocol](./ARCHITECTURE.md#protocol). In short:

```
ws → { type: "hello", roomId, name, color, token? }
ws ← { type: "welcome", userId, snapshot, lamport, serverSeq, peers }
ws ↔ { type: "op",     op: Op }
ws ↔ { type: "cursor", x, y, visible }
```

Ops are `add | remove | patch | noop`. Every op carries
`{clientId, clientSeq, lamport, serverSeq?}`. Server stamps `lamport` and
`serverSeq` on acceptance.

## Companion projects

Part of a three-repo set:

- **[canvaslive](https://github.com/SAY-5/canvaslive)** — you're here. Real-time multiplayer OT.
- **[pluginforge](https://github.com/SAY-5/pluginforge)** — Web Worker plugin sandbox with capability-based permissions.
- **[agentlab](https://github.com/SAY-5/agentlab)** — multi-model AI coding agent evaluation harness.

## License

MIT — see [LICENSE](./LICENSE).
