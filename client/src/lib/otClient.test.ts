import { describe, expect, it } from "vitest";
import type { OpAdd, OpPatch, Stroke } from "@canvaslive/shared";
import { OTClient } from "./otClient.js";

function stroke(id: string, by: string): Stroke {
  return {
    id,
    kind: "stroke",
    points: [],
    color: "#000",
    width: 2,
    z: 0,
    createdBy: by,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("OTClient", () => {
  it("local op is visible in local state, not in serverState", () => {
    const ot = new OTClient("A", () => {});
    const op = ot.localOp<OpAdd>({ type: "add", id: "x", shape: stroke("x", "A") });
    expect(ot.local.has("x")).toBe(true);
    expect(ot.serverState.has("x")).toBe(false);
    expect(op.clientId).toBe("A");
    expect(op.clientSeq).toBe(1);
  });

  it("echoed server op clears the pending entry and updates server state", () => {
    const ot = new OTClient("A", () => {});
    const local = ot.localOp<OpAdd>({
      type: "add",
      id: "x",
      shape: stroke("x", "A"),
    });
    ot.onServerOp({ ...local, serverSeq: 1 });
    expect(ot.pending.length).toBe(0);
    expect(ot.serverState.has("x")).toBe(true);
  });

  it("remote op is rebased over a pending local patch", () => {
    const ot = new OTClient("A", () => {});
    // Base state: shape x exists.
    ot.serverState.set("x", stroke("x", "Z"));
    ot.local = new Map(ot.serverState);
    const localPatch = ot.localOp<OpPatch>({
      type: "patch",
      id: "x",
      patch: { color: "#f00" },
    });
    // Remote concurrent patch on a different field.
    ot.onServerOp({
      type: "patch",
      id: "x",
      patch: { width: 10 },
      clientId: "B",
      clientSeq: 1,
      lamport: localPatch.lamport + 1,
      serverSeq: 1,
    });
    const s = ot.local.get("x") as Stroke;
    expect(s.color).toBe("#f00");
    expect(s.width).toBe(10);
  });

  it("TP1 convergence with TWO pending local ops and a concurrent remote", () => {
    // This is the case the old code got wrong: the remote op was rebased
    // against un-rebased pending entries. The rewritten onServerOp walks
    // the pending list once and advances both the rebased remote and each
    // rebased local alongside each other.
    const a = new OTClient("A", () => {});
    a.serverState.set("x", stroke("x", "Z"));
    a.local = new Map(a.serverState);
    // Two pending local patches on disjoint fields.
    const p1 = a.localOp<OpPatch>({ type: "patch", id: "x", patch: { color: "#f00" } });
    const p2 = a.localOp<OpPatch>({ type: "patch", id: "x", patch: { width: 99 } });
    // Concurrent remote patch on yet another field.
    a.onServerOp({
      type: "patch",
      id: "x",
      patch: { z: 5 },
      clientId: "B",
      clientSeq: 1,
      lamport: Math.max(p1.lamport, p2.lamport) + 1,
      serverSeq: 1,
    });
    const s = a.local.get("x") as Stroke;
    expect(s.color).toBe("#f00");
    expect(s.width).toBe(99);
    expect(s.z).toBe(5);
    // Pending entries are still there, with their clientSeq preserved so
    // the server echoes can still drain them correctly.
    expect(a.pending.length).toBe(2);
    expect(a.pending.map((p) => p.clientSeq)).toEqual([p1.clientSeq, p2.clientSeq]);
  });
});
