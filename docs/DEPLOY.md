# Deploying CanvasLive

CanvasLive is a single stateful Node.js service backed by a local SQLite
file, plus a static client. For real traffic you need to pick **one** of two
postures.

## Posture A — single-instance (≤ a few hundred concurrent users)

Runs anywhere that can run a container: a Fly.io Machine, a Railway
service, an EC2 VM, a Hetzner Cloud box, a Raspberry Pi on your desk.

```bash
docker compose up -d
```

Serve the client from the same origin (any static host — S3+CloudFront,
Cloudflare Pages, a second nginx container). Point it at the server's
WebSocket endpoint.

Required env vars for production:
- `CANVASLIVE_JWT_SECRET`: 16+ chars of entropy. Generate with
  `openssl rand -hex 32`.
- `CANVASLIVE_REQUIRE_AUTH=1` if rooms must be gated by a token you issue
  upstream. Default is `0` (anonymous rooms).
- `CANVASLIVE_CORS_ORIGINS`: exact origins you'll serve the client from.
  `*` is fine for a fully-public demo.

Back up `/data/canvaslive.db` like any SQLite DB: `sqlite3 canvaslive.db
.backup canvaslive-$(date +%F).db` on a cron, or run Litestream against
S3 for continuous replication.

### Sizing rule of thumb (empirical)

From the in-process load test (`npm -w server run test` → `load` case):
**512 ops/s with 20 concurrent clients and per-client convergence** on an
M-series laptop. Expect roughly similar numbers in cloud containers with
≥1 vCPU. That's enough for one small team; beyond it, see Posture B.

## Posture B — horizontally scaled

CanvasLive is **not** a stateless service. Each room is owned by a single
Node process that holds the authoritative OT state. Scaling horizontally
means:

1. **Sticky routing by room id**. Clients for the same room must land on
   the same server instance. Easiest via a consistent-hash load balancer
   keyed on the `/ws/room/:id` path segment. HAProxy, Envoy, and most
   cloud load balancers support this.
2. **Shared persistence** for warm-start across restarts. Swap SQLite for
   Postgres by implementing the `Store` interface (see
   `server/src/store.ts`) against `pg`. The schema is already suitable.
3. **Heartbeat + graceful drain**. On rolling deploys, each instance
   should stop accepting new WS upgrades but keep existing rooms alive
   until they idle out. The process already `flush`es on SIGTERM.

Explicitly out of scope for this repo:
- **Multi-region writes**. OT is single-writer-per-room by construction;
  making it multi-region requires a consensus layer (Raft per room, or a
  CRDT rewrite). Don't.
- **Inter-instance room migration**. Possible with a snapshot+replay
  handoff over the shared store, but the protocol for that isn't
  implemented here.

## TLS

Terminate TLS at the reverse proxy (nginx, Caddy, Cloudflare). The server
speaks plain HTTP/WS inside the container. Make sure the proxy passes
`Connection: upgrade` and `Upgrade: websocket` headers — all three major
proxies do this with their default WS config.

## Operational signals

- `/healthz` returns `{"ok":true, "rooms": N}` — use for liveness +
  readiness checks.
- Stdout is structured-ish plain text (no JSON logging yet). Pipe
  through your log pipeline as a free text stream.
- SQLite WAL mode is on by default; back up `.db`, `.db-wal`, `.db-shm`
  together.
