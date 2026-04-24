import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  apply,
  applyAll,
  compose,
  transform,
  transformAll,
} from "../src/ot.js";
import type { DocState, Op, OpAdd, OpPatch, OpRemove, Stroke } from "../src/types.js";

// ---- builders -------------------------------------------------------------

let clock = 0;
function tick() {
  return ++clock;
}

function stroke(id: string, color = "#000", width = 2): Stroke {
  const t = tick();
  return {
    id,
    kind: "stroke",
    points: [],
    color,
    width,
    z: 0,
    createdBy: "test",
    createdAt: t,
    updatedAt: t,
  };
}

function opAdd(client: string, id: string): OpAdd {
  const t = tick();
  return {
    type: "add",
    id,
    shape: { ...stroke(id), createdBy: client, createdAt: t, updatedAt: t },
    clientId: client,
    clientSeq: t,
    lamport: t,
  };
}

function opRemove(client: string, id: string): OpRemove {
  const t = tick();
  return { type: "remove", id, clientId: client, clientSeq: t, lamport: t };
}

function opPatch(
  client: string,
  id: string,
  patch: Record<string, unknown>,
): OpPatch {
  const t = tick();
  return {
    type: "patch",
    id,
    patch: patch as OpPatch["patch"],
    clientId: client,
    clientSeq: t,
    lamport: t,
  };
}

function eq(a: DocState, b: DocState): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const w = b.get(k);
    if (!w) return false;
    if (JSON.stringify(v) !== JSON.stringify(w)) return false;
  }
  return true;
}

// ---- apply ----------------------------------------------------------------

describe("apply", () => {
  it("adds a drawable", () => {
    const s = apply(new Map(), opAdd("A", "x"));
    expect(s.get("x")?.kind).toBe("stroke");
  });

  it("remove is a no-op on absent id", () => {
    const s = apply(new Map(), opRemove("A", "x"));
    expect(s.size).toBe(0);
  });

  it("patch on absent id is a noop", () => {
    const s = apply(new Map(), opPatch("A", "x", { width: 5 }));
    expect(s.size).toBe(0);
  });

  it("patch updates fields and bumps updatedAt", () => {
    let s = apply(new Map(), opAdd("A", "x"));
    const p = opPatch("A", "x", { width: 9 });
    s = apply(s, p);
    const v = s.get("x") as Stroke;
    expect(v.width).toBe(9);
    expect(v.updatedAt).toBe(p.lamport);
  });

  it("patch with $append concatenates points", () => {
    let s = apply(new Map(), opAdd("A", "x"));
    s = apply(s, opPatch("A", "x", { points: { $append: [{ x: 1, y: 2 }] } }));
    s = apply(s, opPatch("A", "x", { points: { $append: [{ x: 3, y: 4 }] } }));
    expect((s.get("x") as Stroke).points).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });
});

// ---- transform convergence (TP1) -----------------------------------------

describe("transform convergence", () => {
  it("concurrent add/add different ids converge", () => {
    const base: DocState = new Map();
    const a = opAdd("A", "x");
    const b = opAdd("B", "y");
    const s1 = applyAll(base, [a, transform(b, a)]);
    const s2 = applyAll(base, [b, transform(a, b)]);
    expect(eq(s1, s2)).toBe(true);
    expect(s1.size).toBe(2);
  });

  it("concurrent remove/remove same id converges", () => {
    const a = opAdd("Z", "x");
    const base = apply(new Map(), a);
    const r1 = opRemove("A", "x");
    const r2 = opRemove("B", "x");
    const s1 = applyAll(base, [r1, transform(r2, r1)]);
    const s2 = applyAll(base, [r2, transform(r1, r2)]);
    expect(eq(s1, s2)).toBe(true);
    expect(s1.size).toBe(0);
  });

  it("concurrent patch/patch on disjoint fields converges", () => {
    const a = opAdd("Z", "x");
    const base = apply(new Map(), a);
    const p1 = opPatch("A", "x", { width: 10 });
    const p2 = opPatch("B", "x", { color: "#f00" });
    const s1 = applyAll(base, [p1, transform(p2, p1)]);
    const s2 = applyAll(base, [p2, transform(p1, p2)]);
    expect(eq(s1, s2)).toBe(true);
    const v = s1.get("x") as Stroke;
    expect(v.width).toBe(10);
    expect(v.color).toBe("#f00");
  });

  it("concurrent patch/patch on same field converges (LWW by lamport)", () => {
    const base = apply(new Map(), opAdd("Z", "x"));
    const p1 = opPatch("A", "x", { width: 10 });
    const p2 = opPatch("B", "x", { width: 20 });
    const s1 = applyAll(base, [p1, transform(p2, p1)]);
    const s2 = applyAll(base, [p2, transform(p1, p2)]);
    expect(eq(s1, s2)).toBe(true);
  });

  it("concurrent remove/patch: remove wins, states converge", () => {
    const base = apply(new Map(), opAdd("Z", "x"));
    const r = opRemove("A", "x");
    const p = opPatch("B", "x", { width: 5 });
    const s1 = applyAll(base, [r, transform(p, r)]);
    const s2 = applyAll(base, [p, transform(r, p)]);
    expect(eq(s1, s2)).toBe(true);
    expect(s1.size).toBe(0);
  });

  it("property: random pairs converge (TP1)", () => {
    const arbOp = (client: string, id: string) =>
      fc.oneof(
        fc.record({ kind: fc.constant("add" as const) }),
        fc.record({ kind: fc.constant("remove" as const) }),
        fc.record({
          kind: fc.constant("patch" as const),
          width: fc.integer({ min: 1, max: 50 }),
        }),
      ).map((pick) => {
        if (pick.kind === "add") return opAdd(client, id);
        if (pick.kind === "remove") return opRemove(client, id);
        return opPatch(client, id, { width: pick.width });
      });

    fc.assert(
      fc.property(
        fc.record({
          sharedId: fc.boolean(),
          a: fc.constant(0),
          b: fc.constant(0),
        }).chain((seed) => {
          const idA = "x";
          const idB = seed.sharedId ? "x" : "y";
          return fc.tuple(arbOp("A", idA), arbOp("B", idB));
        }),
        ([a, b]) => {
          // Set up a base state containing the target ids so remove/patch
          // have something to touch.
          let base: DocState = new Map();
          base = apply(base, opAdd("Z", "x"));
          base = apply(base, opAdd("Z", "y"));

          const s1 = applyAll(base, [a, transform(b, a)]);
          const s2 = applyAll(base, [b, transform(a, b)]);
          return eq(s1, s2);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---- transformAll over a sequence ----------------------------------------

describe("transformAll", () => {
  it("rebases an op over a sequence", () => {
    const base = apply(new Map(), opAdd("Z", "x"));
    const remote1 = opPatch("A", "x", { width: 3 });
    const remote2 = opPatch("A", "x", { width: 7 });
    const local = opPatch("B", "x", { color: "#00f" });
    const rebased = transformAll(local, [remote1, remote2]);
    // The color write is orthogonal to width writes; rebased should keep color.
    expect(rebased.type).toBe("patch");
    expect((rebased as OpPatch).patch.color).toBe("#00f");
  });
});

// ---- compose -------------------------------------------------------------

describe("compose", () => {
  it("add + patch folds into add", () => {
    const a = opAdd("A", "x");
    const p = opPatch("A", "x", { width: 99 });
    const c = compose(a, p);
    expect(c?.type).toBe("add");
    expect(((c as OpAdd).shape as Stroke).width).toBe(99);
  });

  it("patch + patch with $append concatenates", () => {
    const p1 = opPatch("A", "x", { points: { $append: [{ x: 1, y: 1 }] } });
    const p2 = opPatch("A", "x", { points: { $append: [{ x: 2, y: 2 }] } });
    const c = compose(p1, p2);
    expect(c?.type).toBe("patch");
    const pts = (c as OpPatch).patch.points as { $append: unknown[] };
    expect(pts.$append).toHaveLength(2);
  });

  it("add + remove collapses to noop", () => {
    const a = opAdd("A", "x");
    const r = opRemove("A", "x");
    const c = compose(a, r);
    expect(c?.type).toBe("noop");
  });

  it("refuses to compose ops on different ids", () => {
    const a = opAdd("A", "x");
    const b = opAdd("A", "y");
    expect(compose(a, b)).toBeUndefined();
  });
});
