/**
 * Microbenchmarks for the OT engine.
 *
 * Run with: `npm -w shared run bench` (see shared/package.json).
 */
import { bench, describe } from "vitest";
import {
  apply,
  applyAll,
  applyInPlace,
  compose,
  transform,
  type DocState,
  type Op,
  type OpAdd,
  type OpPatch,
  type Stroke,
} from "../src/index.js";

let clock = 0;
const tick = () => ++clock;

function stroke(id: string, n: number): Stroke {
  const t = tick();
  return {
    id,
    kind: "stroke",
    points: Array.from({ length: n }, (_, i) => ({ x: i, y: i, pressure: 1 })),
    color: "#000",
    width: 2,
    z: 0,
    createdBy: "A",
    createdAt: t,
    updatedAt: t,
  };
}

function opAdd(client: string, id: string, points = 0): OpAdd {
  const t = tick();
  const shape = stroke(id, points);
  shape.createdBy = client;
  shape.createdAt = t;
  shape.updatedAt = t;
  return { type: "add", id, shape, clientId: client, clientSeq: t, lamport: t };
}

function opPatch(client: string, id: string, width: number): OpPatch {
  const t = tick();
  return {
    type: "patch",
    id,
    patch: { width },
    clientId: client,
    clientSeq: t,
    lamport: t,
  };
}

describe("apply", () => {
  bench("add into empty state", () => {
    apply(new Map() as DocState, opAdd("A", "x"));
  });

  bench("add into state with 1 000 shapes", () => {
    let s: DocState = new Map();
    for (let i = 0; i < 1000; i++) s = apply(s, opAdd("A", `x${i}`));
    apply(s, opAdd("A", "newId"));
  });

  bench("patch on shape in 1 000-shape state", () => {
    let s: DocState = new Map();
    for (let i = 0; i < 1000; i++) s = apply(s, opAdd("A", `x${i}`));
    apply(s, opPatch("A", "x500", 7));
  });

  bench("applyInPlace on 1 000-shape state (single-writer hot path)", () => {
    const s: DocState = new Map();
    for (let i = 0; i < 1000; i++) applyInPlace(s, opAdd("A", `x${i}`));
    applyInPlace(s, opPatch("A", "x500", 7));
  });
});

describe("transform", () => {
  bench("transform(add, add) different ids", () => {
    transform(opAdd("A", "x"), opAdd("B", "y"));
  });

  bench("transform(patch, patch) same id, LWW merge", () => {
    transform(opPatch("A", "x", 10), opPatch("B", "x", 20));
  });

  bench("transform(add, remove) same id", () => {
    const a = opAdd("A", "x");
    const b: Op = { type: "remove", id: "x", clientId: "B", clientSeq: tick(), lamport: tick() };
    transform(a, b);
  });
});

describe("compose (client-side coalescing)", () => {
  bench("compose 100 $append patches into one", () => {
    let acc: Op = opPatch("A", "x", 1);
    for (let i = 0; i < 100; i++) {
      const next: OpPatch = {
        type: "patch",
        id: "x",
        patch: { points: { $append: [{ x: i, y: i }] } },
        clientId: "A",
        clientSeq: tick(),
        lamport: tick(),
      };
      acc = compose(acc, next) ?? acc;
    }
  });
});

describe("applyAll replay", () => {
  bench("replay 5 000 ops from empty state", () => {
    const ops: Op[] = [];
    for (let i = 0; i < 2500; i++) ops.push(opAdd("A", `x${i}`));
    for (let i = 0; i < 2500; i++) ops.push(opPatch("A", `x${i % 1000}`, i));
    applyAll(new Map(), ops);
  });
});
