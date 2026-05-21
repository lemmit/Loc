import type { ComponentType, ElementType, ReactNode } from "react";
import { useNode } from "@craftjs/core";
import { PRIMITIVES, isContainer, type PrimitiveName } from "./model";

// craft.js User Components for the page-builder primitives.  Each renders a
// lightweight structural stand-in (not the real design-pack output — the canvas
// is a structural editor, not a live preview) and wires craft's connect/drag so
// nodes are selectable, draggable, and droppable.

type Props = Record<string, string | number | undefined>;

function useBox(): { ref: (el: HTMLElement | null) => void; selected: boolean } {
  const {
    connectors: { connect, drag },
    selected,
  } = useNode((state) => ({ selected: state.events.selected }));
  return { ref: (el) => { if (el) connect(drag(el)); }, selected };
}

const boxStyle = (selected: boolean): React.CSSProperties => ({
  outline: selected ? "2px solid var(--mantine-color-blue-5)" : "1px dashed var(--mantine-color-dark-3)",
  borderRadius: 4,
  padding: 6,
  margin: 2,
  cursor: "move",
});

const pill = (text: string, bg: string): JSX.Element => (
  <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 4, background: bg, color: "white" }}>{text}</span>
);

function renderLeaf(name: PrimitiveName, p: Props): ReactNode {
  switch (name) {
    case "Divider":
      return <div style={{ borderTop: "1px solid var(--mantine-color-dark-3)", height: 0 }} />;
    case "Heading":
      return <span style={{ fontWeight: 700, fontSize: 22 - (Number(p.level ?? 2) - 1) * 2 }}>{String(p.text || "Heading")}</span>;
    case "Text":
      return <span>{String(p.text || "Text")}</span>;
    case "Empty":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>{String(p.message || "Empty")}</span>;
    case "Alert":
      return <div style={{ padding: "4px 8px", borderRadius: 4, background: "var(--mantine-color-red-9)", color: "white" }}>{String(p.message || "Alert")}</div>;
    case "Badge":
      return pill(String(p.value || "Badge"), "var(--mantine-color-grape-7)");
    case "Button":
      return pill(String(p.label || "Button") + (p.to ? ` →${p.to}` : ""), "var(--mantine-color-blue-7)");
    case "Anchor":
      return <a style={{ color: "var(--mantine-color-blue-4)" }}>{String(p.text || "Anchor")}{p.to ? ` →${p.to}` : ""}</a>;
    case "List":
      return <span style={{ color: "var(--mantine-color-teal-4)" }}>⊟ List{p.of ? ` of ${p.of}` : ""}</span>;
    case "Form":
      return <span style={{ color: "var(--mantine-color-teal-4)" }}>▤ Form{p.of ? ` of ${p.of}` : p.creates ? ` creates ${p.creates}` : ""}</span>;
    default:
      return String(name);
  }
}

function makeContainer(name: PrimitiveName): ComponentType<{ children?: ReactNode }> {
  const C = ({ children }: { children?: ReactNode }): JSX.Element => {
    const { ref, selected } = useBox();
    return (
      <div ref={ref} data-testid={`c4node-${name}`} style={{ ...boxStyle(selected), background: "var(--mantine-color-dark-6)" }}>
        <div style={{ fontSize: 10, color: "var(--mantine-color-dimmed)", marginBottom: 4 }}>{name}</div>
        <div style={{ display: "flex", flexDirection: name === "Group" || name === "Toolbar" ? "row" : "column", flexWrap: "wrap", gap: 4 }}>
          {children}
        </div>
      </div>
    );
  };
  C.displayName = name;
  // isCanvas so programmatically-added containers accept children.
  (C as { craft?: unknown }).craft = { displayName: name, isCanvas: true };
  return C;
}

function makeLeaf(name: PrimitiveName): ComponentType<Props> {
  const C = (props: Props): JSX.Element => {
    const { ref, selected } = useBox();
    return (
      <div ref={ref} data-testid={`c4node-${name}`} style={boxStyle(selected)}>
        {renderLeaf(name, props)}
      </div>
    );
  };
  C.displayName = name;
  (C as { craft?: unknown }).craft = { displayName: name };
  return C;
}

// Synthetic canvas root (never emitted; see serialize.ts) — craft requires the
// root node to be a canvas.
export function Root({ children }: { children?: ReactNode }): JSX.Element {
  const { connectors: { connect } } = useNode();
  return (
    <div ref={(el) => { if (el) connect(el); }} data-testid="c4builder-canvas" style={{ minHeight: 120, padding: 4 }}>
      {children}
    </div>
  );
}
Root.craft = { displayName: "Root" };

export function Opaque({ raw }: { raw?: string }): JSX.Element {
  const { ref, selected } = useBox();
  return (
    <div ref={ref} data-testid="c4node-Opaque" style={{ ...boxStyle(selected), fontFamily: "monospace", fontSize: 11, color: "var(--mantine-color-dimmed)", whiteSpace: "pre-wrap" }}>
      {raw || "…"}
    </div>
  );
}
Opaque.craft = { displayName: "Opaque" };

// Resolver: Root + Opaque + one component per registered primitive.
export const resolver: Record<string, ElementType> = { Root, Opaque };
for (const name of PRIMITIVES) {
  resolver[name] = isContainer(name) ? makeContainer(name) : makeLeaf(name);
}
