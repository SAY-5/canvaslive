export type Tool = "select" | "pen" | "rect" | "ellipse" | "line" | "text";

const TOOLS: Array<{ id: Tool; label: string; key: string }> = [
  { id: "select", label: "↖", key: "V" },
  { id: "pen", label: "✎", key: "P" },
  { id: "rect", label: "▭", key: "R" },
  { id: "ellipse", label: "◯", key: "E" },
  { id: "line", label: "╱", key: "L" },
  { id: "text", label: "T", key: "T" },
];

export function Toolbar({
  tool,
  onChange,
}: {
  tool: Tool;
  onChange: (t: Tool) => void;
}) {
  return (
    <div className="toolbar">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={t.id === tool ? "active" : ""}
          title={`${t.id} (${t.key})`}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
