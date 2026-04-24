import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientMsg, ServerMsg } from "@canvaslive/shared";
import { start } from "../index.js";

const PORT = 18787 + Math.floor(Math.random() * 1000);

function openWs(roomId: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/room/${roomId}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function recv<T extends ServerMsg["type"]>(
  ws: WebSocket,
  type: T,
  timeoutMs = 2000,
): Promise<Extract<ServerMsg, { type: T }>> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`timeout waiting for ${type}`));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString()) as ServerMsg;
      if (msg.type === type) {
        clearTimeout(to);
        ws.off("message", handler);
        resolve(msg as Extract<ServerMsg, { type: T }>);
      }
    };
    ws.on("message", handler);
  });
}

function send(ws: WebSocket, msg: ClientMsg): void {
  ws.send(JSON.stringify(msg));
}

let tmp: string;
let stopper: (() => Promise<void>) | null = null;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "canvaslive-test-"));
  process.env.PORT = String(PORT);
  process.env.HOST = "127.0.0.1";
  process.env.CANVASLIVE_DB = path.join(tmp, "test.db");
  process.env.CANVASLIVE_JWT_SECRET = "test-secret-at-least-sixteen-chars";
  process.env.CANVASLIVE_REQUIRE_AUTH = "0";
  const server = await start();
  stopper = () => new Promise<void>((r) => server.close(() => r()));
});

afterAll(async () => {
  if (stopper) await stopper();
  rmSync(tmp, { recursive: true, force: true });
});

describe("server integration", () => {
  it("handshake and welcome", async () => {
    const ws = await openWs("roomA");
    send(ws, { type: "hello", roomId: "roomA", name: "alice", color: "#ff0000" });
    const w = await recv(ws, "welcome");
    expect(w.roomId).toBe("roomA");
    expect(Array.isArray(w.snapshot)).toBe(true);
    expect(w.serverSeq).toBe(0);
    ws.close();
  });

  it("two clients converge on a shared add", async () => {
    const a = await openWs("roomB");
    const b = await openWs("roomB");
    send(a, { type: "hello", roomId: "roomB", name: "a", color: "#ff0000" });
    send(b, { type: "hello", roomId: "roomB", name: "b", color: "#00ff00" });
    const aW = await recv(a, "welcome");
    await recv(b, "welcome");

    const op = {
      type: "add" as const,
      id: "shape-1",
      shape: {
        id: "shape-1",
        kind: "rect" as const,
        x: 0,
        y: 0,
        w: 10,
        h: 10,
        stroke: "#000",
        fill: null,
        strokeWidth: 1,
        z: 0,
        createdBy: aW.userId,
        createdAt: 1,
        updatedAt: 1,
      },
      clientId: aW.userId,
      clientSeq: 1,
      lamport: 1,
    };
    send(a, { type: "op", op });
    const broadcast = await recv(b, "op");
    expect(broadcast.op.type).toBe("add");
    expect(broadcast.op.serverSeq).toBe(1);
    a.close();
    b.close();
  });

  it("persists across reconnect", async () => {
    const a = await openWs("roomC");
    send(a, { type: "hello", roomId: "roomC", name: "a", color: "#000" });
    const aW = await recv(a, "welcome");
    const op = {
      type: "add" as const,
      id: "persist-1",
      shape: {
        id: "persist-1",
        kind: "line" as const,
        x1: 0,
        y1: 0,
        x2: 10,
        y2: 10,
        stroke: "#000",
        strokeWidth: 2,
        z: 0,
        createdBy: aW.userId,
        createdAt: 1,
        updatedAt: 1,
      },
      clientId: aW.userId,
      clientSeq: 1,
      lamport: 1,
    };
    send(a, { type: "op", op });
    await recv(a, "op");
    // Give the 50ms persist batch a chance.
    await new Promise((r) => setTimeout(r, 120));
    a.close();

    await new Promise((r) => setTimeout(r, 50));

    const b = await openWs("roomC");
    send(b, { type: "hello", roomId: "roomC", name: "b", color: "#000" });
    const bW = await recv(b, "welcome");
    expect(bW.snapshot.some((s) => s.id === "persist-1")).toBe(true);
    b.close();
  });

  it("rejects ops with a mismatched clientId", async () => {
    const a = await openWs("roomD");
    send(a, { type: "hello", roomId: "roomD", name: "a", color: "#000" });
    await recv(a, "welcome");
    const bogus = {
      type: "add" as const,
      id: "bad",
      shape: {
        id: "bad",
        kind: "rect" as const,
        x: 0,
        y: 0,
        w: 1,
        h: 1,
        stroke: "#000",
        fill: null,
        strokeWidth: 1,
        z: 0,
        createdBy: "someone-else",
        createdAt: 1,
        updatedAt: 1,
      },
      clientId: "someone-else",
      clientSeq: 1,
      lamport: 1,
    };
    const closed = new Promise<number>((resolve) => a.once("close", (c) => resolve(c)));
    send(a, { type: "op", op: bogus });
    const code = await closed;
    expect(code).toBe(1008);
  });
});
