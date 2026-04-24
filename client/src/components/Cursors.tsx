import type { CursorInfo } from "../lib/useRoom.js";
import type { Viewport } from "../lib/renderer.js";

export function Cursors({
  cursors,
  viewport,
}: {
  cursors: Map<string, CursorInfo>;
  viewport: Viewport;
}) {
  return (
    <div className="cursors">
      {Array.from(cursors.values())
        .filter((c) => c.visible)
        .map((c) => {
          const sx = c.x * viewport.scale + viewport.tx;
          const sy = c.y * viewport.scale + viewport.ty;
          return (
            <div
              key={c.userId}
              className="cursor"
              style={{ left: `${sx}px`, top: `${sy}px` }}
            >
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                <path
                  d="M2 2 L2 14 L6 10 L9 17 L11.5 16 L8.5 9 L14 9 Z"
                  fill={c.color}
                  stroke="white"
                  strokeWidth="1"
                />
              </svg>
              <span className="cursor-name" style={{ background: c.color }}>
                {c.name}
              </span>
            </div>
          );
        })}
    </div>
  );
}
