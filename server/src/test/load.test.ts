/**
 * In-process load test: spin up the real server, connect N WebSocket
 * clients to a shared room, have each push a burst of ops, and verify:
 *   1) the server processes them all without error,
 *   2) all clients' final snapshot converges,
 *   3) throughput is above a (generous) floor.
 *
 * This isn't production load testing — for real numbers you want a load
 * generator hitting a real deployment. But it catches regressions in
 * per-op cost, serialization overhead, and fanout complexity.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ClientMsg, Op, ServerMsg } from "@canvaslive/shared";
import { start } from "../index.js";

const PORT = 28000 + Math.floor(Math.random() * 1000);
let tmp: string;
let stopper: (() => Promise<void>) | null = null;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), "canvaslive-load-"));
  process.env.PORT = String(PORT);
  process.env.HOST = "127.0.0.1";
  process.env.CANVASLIVE_DB = path.join(tmp, "load.db");
  process.env.CANVASLIVE_JWT_SECRET = "load-secret-at-least-sixteen-chars";
  process.env.CANVASLIVE_REQUIRE_AUTH = "0";
  process.env.CANVASLIVE_MAX_OPS_PER_SEC = "5000";
  process.env.CANVASLIVE_MAX_BURST = "10000";
  const server = await start();
  stopper = () => new Promise<void>((r) => server.close(() => r()));
});

afterAll(async () => {
  if (stopper) await stopper();
  rmSync(tmp, { recursive: true, force: true });
});

interface Client {
  ws: WebSocket;
  userId: string;
  received: number;
  finalSeq: number;
}

async function openClient(roomId: string, idx: number): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/room/${roomId}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  const hello: ClientMsg = {
    type: "hello",
    roomId,
    name: `u${idx}`,
    color: "#888888",
  };
  ws.send(JSON.stringify(hello));
  const welcome = await new Promise<Extract<ServerMsg, { type: "welcome" }>>(
    (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("welcome timeout")), 5000);
      ws.once("message", (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
    },
  );
  const c: Client = {
    ws,
    userId: welcome.userId,
    received: 0,
    finalSeq: welcome.serverSeq,
  };
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ServerMsg;
    if (msg.type === "op") {
      c.received += 1;
      c.finalSeq = Math.max(c.finalSeq, msg.op.serverSeq ?? 0);
    }
  });
  return c;
}

describe("load", () => {
  it(
    "handles 20 clients × 50 ops each with per-client convergence",
    async () => {
      const N_CLIENTS = 20;
      const OPS_PER = 50;
      const EXPECTED_OPS = N_CLIENTS * OPS_PER;
      const roomId = "load1";

      const clients = await Promise.all(
        Array.from({ length: N_CLIENTS }, (_, i) => openClient(roomId, i)),
      );

      const started = performance.now();
      let clientSeq = 0;
      for (let i = 0; i < OPS_PER; i++) {
        for (const c of clients) {
          clientSeq += 1;
          const op: Op = {
            type: "add",
            id: `${c.userId}:${i}`,
            shape: {
              id: `${c.userId}:${i}`,
              kind: "rect",
              x: i * 10,
              y: 0,
              w: 5,
              h: 5,
              stroke: "#000",
              fill: null,
              strokeWidth: 1,
              z: 0,
              createdBy: c.userId,
              createdAt: clientSeq,
              updatedAt: clientSeq,
            },
            clientId: c.userId,
            clientSeq,
            lamport: clientSeq,
          };
          c.ws.send(JSON.stringify({ type: "op", op }));
        }
      }

      // Poll until every client has received EXPECTED_OPS or we time out.
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (clients.every((c) => c.received >= EXPECTED_OPS)) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const elapsedMs = performance.now() - started;

      for (const c of clients) {
        expect(c.received).toBeGreaterThanOrEqual(EXPECTED_OPS);
      }

      // All clients converged on the same final server sequence.
      const seqs = new Set(clients.map((c) => c.finalSeq));
      expect(seqs.size).toBe(1);

      const opsPerSec = (EXPECTED_OPS / elapsedMs) * 1000;
      // Generous floor: 100 ops/sec is trivially achievable on a modern dev
      // machine. Failures below that almost certainly indicate a regression
      // (e.g. per-op O(n) copy, synchronous IO, fanout quadratic behavior).
      expect(opsPerSec).toBeGreaterThan(100);
      // Log the number so CI runs surface the metric.
      console.log(
        `[load] ${EXPECTED_OPS} ops in ${elapsedMs.toFixed(0)}ms = ${opsPerSec.toFixed(0)} ops/s`,
      );

      for (const c of clients) c.ws.close();
    },
    30_000,
  );
});
