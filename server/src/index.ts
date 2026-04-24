import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  nanoid,
  type ClientMsg,
  type RoomId,
  type ServerMsg,
} from "@canvaslive/shared";
import { loadConfig, type Config } from "./config.js";
import { Auth } from "./auth.js";
import { Room } from "./room.js";
import { Store } from "./store.js";
import { TokenBucket } from "./rateLimit.js";

const ROOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

interface Deps {
  config: Config;
  auth: Auth;
  store: Store;
  rooms: Map<RoomId, Room>;
}

export async function start(config: Config = loadConfig()): Promise<http.Server> {
  const auth = new Auth(config.jwtSecret);
  const store = new Store(config.dbPath);
  const rooms = new Map<RoomId, Room>();
  const deps: Deps = { config, auth, store, rooms };

  const server = http.createServer((req, res) => {
    handleHttp(req, res, deps).catch((err) => {
      console.error("[canvaslive] http handler error", err);
      if (!res.headersSent) res.writeHead(500).end("internal error");
    });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxMessageBytes });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/ws/room/")) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const roomId = url.pathname.slice("/ws/room/".length);
    if (!ROOM_ID_RE.test(roomId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, roomId, deps);
    });
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  console.log(`[canvaslive] listening on http://${config.host}:${config.port}`);

  const shutdown = () => {
    console.log("[canvaslive] shutting down");
    for (const room of rooms.values()) room.shutdown();
    store.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  return server;
}

// ---- HTTP handlers --------------------------------------------------------

async function handleHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: Deps,
): Promise<void> {
  const origin = req.headers.origin ?? "*";
  if (allowOrigin(origin, deps.config.corsOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  switch (url.pathname) {
    case "/healthz":
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, rooms: deps.rooms.size }));
      return;
    case "/auth/anonymous": {
      const name = typeof url.searchParams.get("name") === "string"
        ? (url.searchParams.get("name") as string)
        : "anon";
      const issued = await deps.auth.issueAnonymous(name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(issued));
      return;
    }
    case "/rooms": {
      if (req.method === "POST") {
        const roomId = "r_" + nanoid(10);
        deps.store.ensureRoom(roomId);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ id: roomId, ws: `/ws/room/${roomId}` }));
        return;
      }
      res.writeHead(405).end();
      return;
    }
    default:
      res.writeHead(404).end("not found");
  }
}

function allowOrigin(origin: string, allowed: string[]): boolean {
  if (allowed.includes("*")) return true;
  return allowed.includes(origin);
}

// ---- WebSocket connection lifecycle --------------------------------------

function handleConnection(ws: WebSocket, roomId: RoomId, deps: Deps): void {
  const wsId = "c_" + nanoid(10);
  let userId: string | null = null;
  let bucket: TokenBucket | null = null;
  let joined = false;
  let room: Room | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let alive = true;

  const safeSend = (msg: ServerMsg) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  const closeWith = (code: number, reason: string) => {
    safeSend({ type: "error", code: String(code), message: reason });
    ws.close(code, reason);
  };

  ws.on("message", async (data, isBinary) => {
    if (isBinary) {
      closeWith(1003, "binary frames unsupported");
      return;
    }
    let msg: ClientMsg;
    try {
      msg = JSON.parse(data.toString("utf8")) as ClientMsg;
    } catch {
      closeWith(1007, "invalid json");
      return;
    }
    if (!joined) {
      if (msg.type !== "hello") {
        closeWith(1008, "hello required first");
        return;
      }
      if (msg.roomId !== roomId) {
        closeWith(1008, "roomId mismatch");
        return;
      }
      const name = String(msg.name ?? "anon").slice(0, 32);
      const color = /^#[0-9a-fA-F]{6,8}$/.test(msg.color) ? msg.color : "#888888";
      if (deps.config.requireAuth) {
        if (!msg.token) {
          closeWith(1008, "auth required");
          return;
        }
        try {
          const claims = await deps.auth.verify(msg.token);
          if (!deps.auth.authorizeRoom(claims, roomId)) {
            closeWith(1008, "forbidden for room");
            return;
          }
          userId = claims.sub;
        } catch {
          closeWith(1008, "invalid token");
          return;
        }
      } else {
        userId = msg.token
          ? (await deps.auth.verify(msg.token).catch(() => null))?.sub ??
            "u_" + nanoid(10)
          : "u_" + nanoid(10);
      }
      bucket = new TokenBucket(deps.config.maxOpsPerSec, deps.config.maxBurst);
      room = await getOrCreateRoom(deps, roomId);
      const peers = room.addClient({
        wsId,
        userId,
        name,
        color,
        send: safeSend,
        close: (c, r) => ws.close(c, r),
        bucket,
      });
      joined = true;
      safeSend({
        type: "welcome",
        userId,
        roomId,
        snapshot: room.snapshotDrawables(),
        lamport: room.lamport,
        serverSeq: room.serverSeq,
        peers,
      });
      return;
    }

    if (!room || !bucket || !userId) return;

    switch (msg.type) {
      case "op": {
        // Reject ops from a client impersonating another user.
        if (msg.op.clientId !== userId) {
          closeWith(1008, "op clientId must match user");
          return;
        }
        room.submitOp(wsId, msg.op);
        return;
      }
      case "cursor": {
        // Cursors have their own bucket so a spammy cursor can't lock out ops.
        room.relayCursor(wsId, msg.x, msg.y, msg.visible);
        return;
      }
      case "ack": {
        // Currently a no-op. Could drive per-client buffer trimming later.
        return;
      }
      case "ping": {
        safeSend({ type: "pong", t: msg.t });
        return;
      }
      case "hello":
        closeWith(1008, "already joined");
        return;
    }
  });

  // Liveness: server-side ping every 20s; disconnect if no pong within 45s.
  pingTimer = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }, 20_000);

  ws.on("pong", () => {
    alive = true;
  });

  ws.on("close", () => {
    if (pingTimer) clearInterval(pingTimer);
    if (room && joined) {
      room.removeClient(wsId);
      if (room.clientCount === 0) {
        // Lazy eviction — flush now, leave in memory; real eviction is a
        // cleaner responsibility (not implemented as a separate timer here
        // because the room is cheap to keep and disk sync already happened).
        room.flush();
      }
    }
  });

  ws.on("error", () => {
    ws.terminate();
  });
}

async function getOrCreateRoom(deps: Deps, roomId: RoomId): Promise<Room> {
  const existing = deps.rooms.get(roomId);
  if (existing) return existing;
  deps.store.ensureRoom(roomId);
  const room = new Room(roomId, deps.store, deps.config.snapshotEvery);
  const snap = deps.store.loadSnapshot(roomId);
  if (snap) {
    const pending = (snap as typeof snap & { pendingOps?: unknown[] }).pendingOps as
      | Parameters<Room["hydrate"]>[3]
      | undefined;
    room.hydrate(snap.drawables, snap.lamport, snap.serverSeq, pending ?? []);
  }
  deps.rooms.set(roomId, room);
  return room;
}

// Boot only when invoked as a script.
const isMain =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1] && import.meta.url.endsWith(process.argv[1]));

if (isMain) {
  start().catch((err) => {
    console.error("[canvaslive] failed to start:", err);
    process.exit(1);
  });
}
