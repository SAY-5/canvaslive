import type { DocState, Drawable, Stroke } from "@canvaslive/shared";

export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

export function renderCanvas(
  ctx: CanvasRenderingContext2D,
  state: DocState,
  viewport: Viewport,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.translate(viewport.tx, viewport.ty);
  ctx.scale(viewport.scale, viewport.scale);

  const drawables = Array.from(state.values()).sort(byZ);
  for (const d of drawables) drawOne(ctx, d);

  ctx.restore();
}

function byZ(a: Drawable, b: Drawable): number {
  if (a.z !== b.z) return a.z - b.z;
  return a.createdAt - b.createdAt;
}

function drawOne(ctx: CanvasRenderingContext2D, d: Drawable): void {
  switch (d.kind) {
    case "stroke":
      return drawStroke(ctx, d);
    case "rect": {
      ctx.lineWidth = d.strokeWidth;
      ctx.strokeStyle = d.stroke;
      if (d.fill) {
        ctx.fillStyle = d.fill;
        ctx.fillRect(d.x, d.y, d.w, d.h);
      }
      ctx.strokeRect(d.x, d.y, d.w, d.h);
      return;
    }
    case "ellipse": {
      ctx.lineWidth = d.strokeWidth;
      ctx.strokeStyle = d.stroke;
      ctx.beginPath();
      ctx.ellipse(d.cx, d.cy, d.rx, d.ry, 0, 0, Math.PI * 2);
      if (d.fill) {
        ctx.fillStyle = d.fill;
        ctx.fill();
      }
      ctx.stroke();
      return;
    }
    case "line": {
      ctx.lineWidth = d.strokeWidth;
      ctx.strokeStyle = d.stroke;
      ctx.beginPath();
      ctx.moveTo(d.x1, d.y1);
      ctx.lineTo(d.x2, d.y2);
      ctx.stroke();
      return;
    }
    case "text": {
      ctx.fillStyle = d.color;
      ctx.font = `${d.size}px ${d.font}`;
      ctx.textBaseline = "top";
      ctx.fillText(d.text, d.x, d.y);
      return;
    }
    case "image":
      // Images are rendered via <img> tag overlay in the DOM layer; skip here.
      return;
  }
}

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke): void {
  if (s.points.length === 0) return;
  ctx.lineWidth = s.width;
  ctx.strokeStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  const first = s.points[0]!;
  ctx.moveTo(first.x, first.y);
  if (s.points.length === 1) {
    ctx.arc(first.x, first.y, s.width / 2, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    return;
  }
  for (let i = 1; i < s.points.length; i++) {
    const p = s.points[i]!;
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

export function worldFromScreen(
  x: number,
  y: number,
  viewport: Viewport,
): { x: number; y: number } {
  return {
    x: (x - viewport.tx) / viewport.scale,
    y: (y - viewport.ty) / viewport.scale,
  };
}
