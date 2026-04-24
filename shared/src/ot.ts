// Operational Transform over the CanvasLive drawable model.
//
// Correctness property (TP1): for any concurrent ops a, b and any state s,
//   apply(apply(s, a), transform(b, a)) ==
//   apply(apply(s, b), transform(a, b))
//
// We encode "this op is now redundant" as a `noop` rather than dropping, so
// Lamport clocks and sequence numbers stay aligned across peers.

import type {
  Drawable,
  DocState,
  Op,
  OpAdd,
  OpNoop,
  OpPatch,
  OpRemove,
  PatchValue,
} from "./types.js";

// ---------- apply ----------------------------------------------------------

export function apply(state: DocState, op: Op): DocState {
  const next = new Map(state);
  switch (op.type) {
    case "add": {
      // add is idempotent on id: a second add for the same id upgrades
      // updatedAt but leaves the earlier createdAt.
      const existing = next.get(op.id);
      if (existing) {
        next.set(op.id, {
          ...existing,
          ...op.shape,
          createdAt: existing.createdAt,
          updatedAt: Math.max(existing.updatedAt, op.lamport),
        });
      } else {
        next.set(op.id, op.shape);
      }
      return next;
    }
    case "remove": {
      next.delete(op.id);
      return next;
    }
    case "patch": {
      const existing = next.get(op.id);
      if (!existing) return next; // patch on absent → noop in state
      next.set(op.id, applyPatch(existing, op.patch, op.lamport));
      return next;
    }
    case "noop":
      return next;
  }
}

export function applyAll(state: DocState, ops: readonly Op[]): DocState {
  let s = state;
  for (const op of ops) s = apply(s, op);
  return s;
}

function applyPatch(
  shape: Drawable,
  patch: Record<string, PatchValue>,
  lamport: number,
): Drawable {
  const next: Record<string, unknown> = { ...shape };
  for (const [key, value] of Object.entries(patch)) {
    if (isAppend(value)) {
      const existing = Array.isArray(next[key]) ? (next[key] as unknown[]) : [];
      next[key] = [...existing, ...value.$append];
    } else {
      next[key] = value;
    }
  }
  next.updatedAt = Math.max(shape.updatedAt, lamport);
  return next as unknown as Drawable;
}

function isAppend(v: PatchValue): v is { $append: unknown[] } {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    "$append" in v &&
    Array.isArray((v as { $append: unknown[] }).$append)
  );
}

// ---------- transform ------------------------------------------------------

/**
 * Return a' such that applying a after b is equivalent to applying a
 * originally (with b absent). "Concurrent" means neither has observed the
 * other yet — they were derived from the same base state.
 */
export function transform(a: Op, b: Op): Op {
  if (a.type === "noop" || b.type === "noop") return a;

  // Different targets → no interaction.
  const aId = (a as OpAdd | OpRemove | OpPatch).id;
  const bId = (b as OpAdd | OpRemove | OpPatch).id;
  if (aId !== bId) return a;

  if (a.type === "add" && b.type === "add") {
    // Same id + concurrent add. IDs are client-unique nanoids, so same-id
    // concurrent add effectively means two peers rebuilding from a fork; the
    // higher-lamport loses to match LWW-on-create semantics, becoming a noop.
    return bLamportGt(b, a) ? asNoop(a) : a;
  }

  if (a.type === "remove" && b.type === "remove") {
    return asNoop(a); // b removed it first; a has nothing to do.
  }

  if (a.type === "remove" && b.type === "add") {
    // Concurrent add+remove on the same id: remove wins (last-write-wins with
    // remove prioritized), so a stands.
    return a;
  }
  if (a.type === "add" && b.type === "remove") {
    // b removed what a would create; a becomes a noop (convergence via
    // remove-wins). Alternative: keep a. We pick remove-wins because it
    // matches the "explicit user intent to delete" preference.
    return asNoop(a);
  }

  if (a.type === "remove" && b.type === "patch") return a; // remove wins
  if (a.type === "patch" && b.type === "remove") return asNoop(a);

  if (a.type === "patch" && b.type === "add") {
    // b just created, a is patching concurrently → patch a drops (nothing
    // existed at the base state that a's patch should target).
    return asNoop(a);
  }
  if (a.type === "add" && b.type === "patch") {
    // Patch targeted a shape that didn't exist at base; a creates it.
    // The patch will apply after a with effect, so a is unchanged.
    return a;
  }

  if (a.type === "patch" && b.type === "patch") {
    // Field-wise merge: drop fields from a that b also writes, but only if
    // b's lamport is greater (LWW per field).
    return mergePatches(a, b);
  }

  return a;
}

function bLamportGt(b: Op, a: Op): boolean {
  if (b.lamport !== a.lamport) return b.lamport > a.lamport;
  // Tiebreak by (clientId, clientSeq) lexicographic.
  if (b.clientId !== a.clientId) return b.clientId > a.clientId;
  return b.clientSeq > a.clientSeq;
}

function mergePatches(a: OpPatch, b: OpPatch): Op {
  const bWins = bLamportGt(b, a);
  const nextPatch: Record<string, PatchValue> = {};
  for (const [key, value] of Object.entries(a.patch)) {
    if (key in b.patch) {
      // Conflict on this field.
      if (isAppend(value) && isAppend(b.patch[key] as PatchValue)) {
        // Two $append ops: concat both (order doesn't matter for strokes since
        // the full point list is eventually merged; we append a's extras after
        // b's when b wins, so a's must be rebased to append *after* b's).
        nextPatch[key] = value; // keep a's append; b's already applied
      } else if (bWins) {
        // Drop a's write; b already set this field.
        continue;
      } else {
        nextPatch[key] = value;
      }
    } else {
      nextPatch[key] = value;
    }
  }
  if (Object.keys(nextPatch).length === 0) return asNoop(a);
  return { ...a, patch: nextPatch };
}

// ---------- compose --------------------------------------------------------

/**
 * Merge two sequential ops from the same client into one, if possible.
 * Returns undefined if they can't be composed cleanly.
 */
export function compose(a: Op, b: Op): Op | undefined {
  if (a.type === "noop") return b;
  if (b.type === "noop") return a;

  const aId = (a as OpAdd | OpRemove | OpPatch).id;
  const bId = (b as OpAdd | OpRemove | OpPatch).id;
  if (aId !== bId) return undefined;

  if (a.type === "add" && b.type === "patch") {
    const composed: OpAdd = {
      ...a,
      shape: applyPatch(a.shape, b.patch, b.lamport),
      lamport: b.lamport,
      clientSeq: b.clientSeq,
    };
    return composed;
  }

  if (a.type === "patch" && b.type === "patch") {
    const merged: Record<string, PatchValue> = { ...a.patch };
    for (const [key, value] of Object.entries(b.patch)) {
      if (isAppend(value) && isAppend(merged[key] as PatchValue)) {
        merged[key] = {
          $append: [
            ...(merged[key] as { $append: unknown[] }).$append,
            ...value.$append,
          ],
        };
      } else {
        merged[key] = value;
      }
    }
    return { ...a, patch: merged, lamport: b.lamport, clientSeq: b.clientSeq };
  }

  if (a.type === "add" && b.type === "remove") {
    // Created then removed in the same batch — becomes a noop.
    return asNoop(a);
  }

  if (a.type === "patch" && b.type === "remove") {
    return b; // remove supersedes preceding patch
  }

  return undefined;
}

// ---------- helpers --------------------------------------------------------

function asNoop(op: Op): OpNoop {
  return {
    type: "noop",
    clientId: op.clientId,
    clientSeq: op.clientSeq,
    lamport: op.lamport,
    ...(op.serverSeq !== undefined ? { serverSeq: op.serverSeq } : {}),
  };
}

export function transformAll(op: Op, against: readonly Op[]): Op {
  let cur = op;
  for (const other of against) cur = transform(cur, other);
  return cur;
}
