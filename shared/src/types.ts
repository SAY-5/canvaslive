// Document model + operation types shared by server and client.

export type UserId = string;
export type DrawableId = string;
export type RoomId = string;

export type Color = string; // "#rrggbb" or "#rrggbbaa"

export interface BaseDrawable {
  id: DrawableId;
  z: number;
  createdBy: UserId;
  createdAt: number; // Lamport timestamp
  updatedAt: number; // Lamport timestamp
}

export interface Stroke extends BaseDrawable {
  kind: "stroke";
  points: Array<{ x: number; y: number; pressure?: number }>;
  color: Color;
  width: number;
  smooth?: boolean;
}

export interface Rect extends BaseDrawable {
  kind: "rect";
  x: number;
  y: number;
  w: number;
  h: number;
  stroke: Color;
  fill: Color | null;
  strokeWidth: number;
  radius?: number;
}

export interface Ellipse extends BaseDrawable {
  kind: "ellipse";
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  stroke: Color;
  fill: Color | null;
  strokeWidth: number;
}

export interface Line extends BaseDrawable {
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: Color;
  strokeWidth: number;
}

export interface TextShape extends BaseDrawable {
  kind: "text";
  x: number;
  y: number;
  text: string;
  font: string;
  size: number;
  color: Color;
}

export interface ImageShape extends BaseDrawable {
  kind: "image";
  x: number;
  y: number;
  w: number;
  h: number;
  href: string;
}

export type Drawable = Stroke | Rect | Ellipse | Line | TextShape | ImageShape;

export type DocState = Map<DrawableId, Drawable>;

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface OpBase {
  clientId: UserId;
  clientSeq: number;
  lamport: number;
  serverSeq?: number;
}

export interface OpAdd extends OpBase {
  type: "add";
  id: DrawableId;
  shape: Drawable;
}

export interface OpRemove extends OpBase {
  type: "remove";
  id: DrawableId;
}

export type PatchValue =
  | string
  | number
  | boolean
  | null
  | { $append: Array<unknown> }
  | Array<unknown>
  | Record<string, unknown>;

export interface OpPatch extends OpBase {
  type: "patch";
  id: DrawableId;
  patch: Record<string, PatchValue>;
}

export interface OpNoop extends OpBase {
  type: "noop";
}

export type Op = OpAdd | OpRemove | OpPatch | OpNoop;

// ---------------------------------------------------------------------------
// Wire protocol
// ---------------------------------------------------------------------------

export interface Peer {
  userId: UserId;
  name: string;
  color: Color;
}

export type ClientMsg =
  | { type: "hello"; token?: string; roomId: RoomId; name: string; color: Color }
  | { type: "op"; op: Op }
  | { type: "cursor"; x: number; y: number; visible: boolean }
  | { type: "ack"; serverSeq: number }
  | { type: "ping"; t: number };

export type ServerMsg =
  | {
      type: "welcome";
      userId: UserId;
      roomId: RoomId;
      snapshot: Drawable[];
      lamport: number;
      serverSeq: number;
      peers: Peer[];
    }
  | { type: "op"; op: Op }
  | { type: "cursor"; userId: UserId; x: number; y: number; visible: boolean }
  | { type: "peer"; peer: Peer; joined: boolean }
  | { type: "error"; code: string; message: string }
  | { type: "pong"; t: number };
