import { useEffect, useRef, useState } from "react";
import type {
  ClientMsg,
  Drawable,
  Op,
  OpAdd,
  OpPatch,
  OpRemove,
  Peer,
  ServerMsg,
  UserId,
} from "@canvaslive/shared";
import { OTClient, parseServerMsg } from "./otClient.js";

export type ConnectionState = "disconnected" | "connecting" | "connected";

export interface CursorInfo {
  userId: UserId;
  x: number;
  y: number;
  visible: boolean;
  name: string;
  color: string;
}

export interface UseRoomOptions {
  wsUrl: string;
  roomId: string;
  name: string;
  color: string;
  token?: string;
}

export interface UseRoomApi {
  state: ConnectionState;
  userId: UserId | null;
  peers: Map<UserId, Peer>;
  cursors: Map<UserId, CursorInfo>;
  drawables: Drawable[];
  addShape: (shape: Drawable) => void;
  removeShape: (id: string) => void;
  patchShape: (id: string, patch: OpPatch["patch"]) => void;
  appendStrokePoint: (
    id: string,
    point: { x: number; y: number; pressure?: number },
  ) => void;
  sendCursor: (x: number, y: number, visible: boolean) => void;
}

export function useRoom(opts: UseRoomOptions): UseRoomApi {
  const [state, setState] = useState<ConnectionState>("disconnected");
  const [userId, setUserId] = useState<UserId | null>(null);
  const [, forceRender] = useState(0);
  const peersRef = useRef(new Map<UserId, Peer>());
  const cursorsRef = useRef(new Map<UserId, CursorInfo>());
  const otRef = useRef<OTClient | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastCursorSent = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setState("connecting");
    const ws = new WebSocket(opts.wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      const hello: ClientMsg = {
        type: "hello",
        roomId: opts.roomId,
        name: opts.name,
        color: opts.color,
        ...(opts.token ? { token: opts.token } : {}),
      };
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = (ev) => {
      const msg = parseServerMsg(typeof ev.data === "string" ? ev.data : "");
      if (!msg || cancelled) return;
      handle(msg);
    };

    ws.onclose = () => {
      if (!cancelled) setState("disconnected");
    };

    ws.onerror = () => {
      // Propagated via onclose.
    };

    function handle(msg: ServerMsg): void {
      switch (msg.type) {
        case "welcome": {
          setUserId(msg.userId);
          setState("connected");
          const snapshot = new Map(msg.snapshot.map((d) => [d.id, d]));
          const ot = new OTClient(msg.userId, () => forceRender((x) => x + 1));
          ot.onWelcome(snapshot, msg.lamport);
          otRef.current = ot;
          peersRef.current.clear();
          for (const p of msg.peers) peersRef.current.set(p.userId, p);
          forceRender((x) => x + 1);
          return;
        }
        case "op": {
          otRef.current?.onServerOp(msg.op);
          return;
        }
        case "cursor": {
          const peer = peersRef.current.get(msg.userId);
          cursorsRef.current.set(msg.userId, {
            userId: msg.userId,
            x: msg.x,
            y: msg.y,
            visible: msg.visible,
            name: peer?.name ?? "peer",
            color: peer?.color ?? "#888",
          });
          forceRender((x) => x + 1);
          return;
        }
        case "peer": {
          if (msg.joined) {
            peersRef.current.set(msg.peer.userId, msg.peer);
          } else {
            peersRef.current.delete(msg.peer.userId);
            cursorsRef.current.delete(msg.peer.userId);
          }
          forceRender((x) => x + 1);
          return;
        }
        case "error": {
          console.warn("[canvaslive] server error:", msg.code, msg.message);
          return;
        }
        case "pong":
          return;
      }
    }

    return () => {
      cancelled = true;
      ws.close();
    };
  }, [opts.wsUrl, opts.roomId, opts.name, opts.color, opts.token]);

  function send(msg: ClientMsg): void {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  function submit<T extends Op>(partial: Omit<T, "clientId" | "clientSeq" | "lamport">): void {
    const ot = otRef.current;
    if (!ot) return;
    const op = ot.localOp<T>(partial);
    send({ type: "op", op });
  }

  const drawables = otRef.current
    ? Array.from(otRef.current.local.values())
    : [];

  return {
    state,
    userId,
    peers: peersRef.current,
    cursors: cursorsRef.current,
    drawables,
    addShape: (shape) => {
      submit<OpAdd>({ type: "add", id: shape.id, shape });
    },
    removeShape: (id) => {
      submit<OpRemove>({ type: "remove", id });
    },
    patchShape: (id, patch) => {
      submit<OpPatch>({ type: "patch", id, patch });
    },
    appendStrokePoint: (id, point) => {
      submit<OpPatch>({
        type: "patch",
        id,
        patch: { points: { $append: [point] } },
      });
    },
    sendCursor: (x, y, visible) => {
      const now = performance.now();
      if (now - lastCursorSent.current < 33) return; // ~30Hz throttle
      lastCursorSent.current = now;
      send({ type: "cursor", x, y, visible });
    },
  };
}
