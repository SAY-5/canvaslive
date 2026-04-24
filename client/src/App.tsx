import { useCallback, useEffect, useRef, useState } from "react";
import type { Drawable, Stroke } from "@canvaslive/shared";
import { nanoid } from "@canvaslive/shared";
import { Toolbar, type Tool } from "./components/Toolbar.js";
import { Cursors } from "./components/Cursors.js";
import {
  renderCanvas,
  worldFromScreen,
  type Viewport,
} from "./lib/renderer.js";
import { useRoom } from "./lib/useRoom.js";

const COLORS = ["#ff5a5f", "#ffb400", "#2ed573", "#1e90ff", "#a55eea", "#ffffff"];

interface JoinInfo {
  roomId: string;
  name: string;
  color: string;
}

function defaultRoomId(): string {
  const h = location.hash.replace(/^#\/?/, "").trim();
  return h.length > 0 ? h : "r_" + Math.random().toString(36).slice(2, 10);
}

export function App() {
  const [join, setJoin] = useState<JoinInfo | null>(null);
  if (!join) return <JoinScreen onJoin={setJoin} />;
  return <Whiteboard join={join} />;
}

function JoinScreen({ onJoin }: { onJoin: (j: JoinInfo) => void }) {
  const [roomId, setRoomId] = useState(defaultRoomId());
  const [name, setName] = useState("anon");
  const [color, setColor] = useState(COLORS[3]!);
  const enter = () => {
    location.hash = `/${roomId}`;
    onJoin({ roomId, name, color });
  };
  return (
    <div className="join">
      <div className="join-inner">
        <div className="join-hero">
          <p className="join-eyebrow">Canvas · Live</p>
          <h1>
            Draw, together,
            <br />
            <em>in real time.</em>
          </h1>
          <p>
            A multiplayer whiteboard with operational-transform conflict
            resolution. Every stroke converges across every client,
            every order.
          </p>
        </div>
        <div className="join-card">
          <div className="join-field">
            <label htmlFor="join-room">Room</label>
            <input
              id="join-room"
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && enter()}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </div>
          <div className="join-field">
            <label htmlFor="join-name">Name</label>
            <input
              id="join-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && enter()}
              maxLength={32}
            />
          </div>
          <div className="join-field">
            <label>Cursor color</label>
            <div className="join-colors">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  style={{ background: c }}
                  className={c === color ? "selected" : ""}
                  aria-label={`color ${c}`}
                  aria-pressed={c === color}
                />
              ))}
            </div>
          </div>
          <button className="join-enter" type="button" onClick={enter}>
            <span>Enter room</span>
            <span className="arrow" aria-hidden>→</span>
          </button>
        </div>
        <div className="join-footer">
          <span>OT engine · 16 tests · 500-run property</span>
          <a href="https://github.com/SAY-5/canvaslive" target="_blank" rel="noreferrer">
            github.com/SAY-5/canvaslive
          </a>
        </div>
      </div>
    </div>
  );
}

function Whiteboard({ join }: { join: JoinInfo }) {
  const wsUrl = (() => {
    const loc = window.location;
    const proto = loc.protocol === "https:" ? "wss:" : "ws:";
    // Dev proxy maps /ws to the server.
    return `${proto}//${loc.host}/ws/room/${join.roomId}`;
  })();

  const room = useRoom({ ...join, wsUrl });
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState("#ffffff");
  const [strokeWidth, setStrokeWidth] = useState(3);
  const [viewport, setViewport] = useState<Viewport>({ tx: 0, ty: 0, scale: 1 });
  const activeDraw = useRef<{
    id: string;
    startWorld: { x: number; y: number };
  } | null>(null);
  const panActive = useRef<{ x: number; y: number } | null>(null);

  // Redraw whenever drawables or viewport change.
  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const dpr = window.devicePixelRatio || 1;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const state = new Map(room.drawables.map((d) => [d.id, d]));
    renderCanvas(ctx, state, viewport, w, h);
  }, [room.drawables, viewport]);

  // Resize redraws.
  useEffect(() => {
    const onResize = () => setViewport((v) => ({ ...v }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const map: Record<string, Tool> = {
        v: "select",
        p: "pen",
        r: "rect",
        e: "ellipse",
        l: "line",
        t: "text",
      };
      if (map[e.key.toLowerCase()]) {
        setTool(map[e.key.toLowerCase()]!);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number) => {
      const rect = stageRef.current!.getBoundingClientRect();
      return worldFromScreen(clientX - rect.left, clientY - rect.top, viewport);
    },
    [viewport],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 1 || (e.button === 0 && e.shiftKey)) {
      panActive.current = { x: e.clientX, y: e.clientY };
      (e.target as Element).setPointerCapture(e.pointerId);
      return;
    }
    if (!room.userId) return;
    const p = screenToWorld(e.clientX, e.clientY);
    const id = "d_" + nanoid(10);
    const baseMeta = {
      id,
      z: 0,
      createdBy: room.userId,
      createdAt: 0,
      updatedAt: 0,
    };
    let shape: Drawable | null = null;
    if (tool === "pen") {
      const s: Stroke = {
        ...baseMeta,
        kind: "stroke",
        points: [{ x: p.x, y: p.y, pressure: e.pressure || 1 }],
        color,
        width: strokeWidth,
      };
      shape = s;
    } else if (tool === "rect") {
      shape = {
        ...baseMeta,
        kind: "rect",
        x: p.x,
        y: p.y,
        w: 0,
        h: 0,
        stroke: color,
        fill: null,
        strokeWidth,
      };
    } else if (tool === "ellipse") {
      shape = {
        ...baseMeta,
        kind: "ellipse",
        cx: p.x,
        cy: p.y,
        rx: 0,
        ry: 0,
        stroke: color,
        fill: null,
        strokeWidth,
      };
    } else if (tool === "line") {
      shape = {
        ...baseMeta,
        kind: "line",
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
        stroke: color,
        strokeWidth,
      };
    } else if (tool === "text") {
      const text = prompt("Text:") ?? "";
      if (!text) return;
      shape = {
        ...baseMeta,
        kind: "text",
        x: p.x,
        y: p.y,
        text,
        font: "sans-serif",
        size: 20,
        color,
      };
    }
    if (!shape) return;
    room.addShape(shape);
    activeDraw.current = { id, startWorld: p };
    (e.target as Element).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (panActive.current) {
      const dx = e.clientX - panActive.current.x;
      const dy = e.clientY - panActive.current.y;
      panActive.current = { x: e.clientX, y: e.clientY };
      setViewport((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }));
      return;
    }
    const p = screenToWorld(e.clientX, e.clientY);
    room.sendCursor(p.x, p.y, true);

    const active = activeDraw.current;
    if (!active) return;
    if (tool === "pen") {
      room.appendStrokePoint(active.id, {
        x: p.x,
        y: p.y,
        pressure: e.pressure || 1,
      });
    } else if (tool === "rect") {
      room.patchShape(active.id, {
        x: Math.min(active.startWorld.x, p.x),
        y: Math.min(active.startWorld.y, p.y),
        w: Math.abs(p.x - active.startWorld.x),
        h: Math.abs(p.y - active.startWorld.y),
      });
    } else if (tool === "ellipse") {
      room.patchShape(active.id, {
        cx: (active.startWorld.x + p.x) / 2,
        cy: (active.startWorld.y + p.y) / 2,
        rx: Math.abs(p.x - active.startWorld.x) / 2,
        ry: Math.abs(p.y - active.startWorld.y) / 2,
      });
    } else if (tool === "line") {
      room.patchShape(active.id, { x2: p.x, y2: p.y });
    }
  };

  const onPointerUp = () => {
    panActive.current = null;
    activeDraw.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = stageRef.current!.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const zoomBy = Math.exp(-e.deltaY * 0.001);
    setViewport((v) => {
      const newScale = Math.max(0.1, Math.min(8, v.scale * zoomBy));
      const sx = (cx - v.tx) / v.scale;
      const sy = (cy - v.ty) / v.scale;
      return { scale: newScale, tx: cx - sx * newScale, ty: cy - sy * newScale };
    });
  };

  return (
    <div className="app">
      <Toolbar tool={tool} onChange={setTool} />
      <div
        className="stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => room.sendCursor(0, 0, false)}
        onWheel={onWheel}
      >
        <canvas ref={canvasRef} className="main" />
        <Cursors cursors={room.cursors} viewport={viewport} />
        <div className="palette" role="group" aria-label="Stroke options">
          <span className="palette-label">Stroke</span>
          <div className="palette-swatches">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                style={{ background: c }}
                className={c === color ? "selected" : ""}
                aria-label={`color ${c}`}
                aria-pressed={c === color}
              />
            ))}
          </div>
          <div className="palette-size">
            <input
              type="range"
              min={1}
              max={32}
              value={strokeWidth}
              onChange={(e) => setStrokeWidth(Number(e.target.value))}
              aria-label="stroke width"
            />
            <span className="palette-size-value">{strokeWidth}</span>
          </div>
        </div>
        <div className={`status ${room.state}`}>
          <span>
            {room.state === "connected"
              ? `Room ${join.roomId}`
              : room.state}
          </span>
          {room.userId && (
            <span style={{ color: "var(--ink-4)" }}>
              · {room.peers.size + 1} {room.peers.size === 0 ? "person" : "people"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
