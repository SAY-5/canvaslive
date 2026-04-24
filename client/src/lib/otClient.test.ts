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
});
