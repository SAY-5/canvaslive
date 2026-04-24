export type Tool = "select" | "pen" | "rect" | "ellipse" | "line" | "text";

interface ToolDef {
  id: Tool;
  key: string;
  icon: string;
  label: string;
}

const TOOLS: ToolDef[] = [
  { id: "select", key: "V", icon: "↖", label: "Select" },
  { id: "pen", key: "P", icon: "✎", label: "Pen" },
  { id: "rect", key: "R", icon: "▭", label: "Rectangle" },
  { id: "ellipse", key: "E", icon: "◯", label: "Ellipse" },
  { id: "line", key: "L", icon: "╱", label: "Line" },
  { id: "text", key: "T", icon: "T", label: "Text" },
];

export function Toolbar({
  tool,
  onChange,
}: {
  tool: Tool;
  onChange: (t: Tool) => void;
}) {
  return (
    <div className="toolbar" role="toolbar" aria-label="Drawing tools">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={t.id === tool ? "active" : ""}
          title={`${t.label} (${t.key})`}
          aria-label={`${t.label}, keyboard shortcut ${t.key}`}
          aria-pressed={t.id === tool}
          onClick={() => onChange(t.id)}
        >
          {t.icon}
        </button>
      ))}
    </div>
  );
}
