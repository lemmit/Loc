import type { ReactNode } from "react";
import { useNode } from "@craftjs/core";

// craft.js User Components for the page-builder MVP primitives.  Each renders a
// lightweight visual stand-in (not the real design-pack output — the canvas is
// a structural editor, not a live preview) and wires craft's connect/drag so
// nodes are selectable and movable.

const selectableStyle = (selected: boolean): React.CSSProperties => ({
  outline: selected ? "2px solid var(--mantine-color-blue-5)" : "1px dashed var(--mantine-color-dark-3)",
  borderRadius: 4,
  padding: 6,
  margin: 2,
  cursor: "move",
});

function useCraftBox(): {
  ref: (el: HTMLElement | null) => void;
  selected: boolean;
} {
  const {
    connectors: { connect, drag },
    selected,
  } = useNode((state) => ({ selected: state.events.selected }));
  return { ref: (el) => { if (el) connect(drag(el)); }, selected };
}

function Container({ label, children }: { label: string; children?: ReactNode }): JSX.Element {
  const { ref, selected } = useCraftBox();
  return (
    <div ref={ref} data-testid={`c4node-${label}`} style={{ ...selectableStyle(selected), background: "var(--mantine-color-dark-6)" }}>
      <div style={{ fontSize: 10, color: "var(--mantine-color-dimmed)", marginBottom: 4 }}>{label}</div>
      <div style={{ display: "flex", flexDirection: label === "Group" ? "row" : "column", gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

export function Stack({ children }: { children?: ReactNode }): JSX.Element {
  return <Container label="Stack">{children}</Container>;
}
Stack.craft = { displayName: "Stack" };

export function Group({ children }: { children?: ReactNode }): JSX.Element {
  return <Container label="Group">{children}</Container>;
}
Group.craft = { displayName: "Group" };

export function Heading({ text, level }: { text?: string; level?: number }): JSX.Element {
  const { ref, selected } = useCraftBox();
  return (
    <div ref={ref} data-testid="c4node-Heading" style={selectableStyle(selected)}>
      <span style={{ fontWeight: 700, fontSize: 18 - (Number(level ?? 2) - 1) * 2 }}>{text || "Heading"}</span>
    </div>
  );
}
Heading.craft = { displayName: "Heading" };

export function Text({ text }: { text?: string }): JSX.Element {
  const { ref, selected } = useCraftBox();
  return (
    <div ref={ref} data-testid="c4node-Text" style={selectableStyle(selected)}>
      {text || "Text"}
    </div>
  );
}
Text.craft = { displayName: "Text" };

export function Button({ label, to }: { label?: string; to?: string }): JSX.Element {
  const { ref, selected } = useCraftBox();
  return (
    <div ref={ref} data-testid="c4node-Button" style={selectableStyle(selected)}>
      <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 4, background: "var(--mantine-color-blue-7)", color: "white" }}>
        {label || "Button"}{to ? ` →${to}` : ""}
      </span>
    </div>
  );
}
Button.craft = { displayName: "Button" };

// Synthetic canvas root (never emitted) — see serialize.ts.  craft requires
// the root node to be a canvas; this just hosts the real body node.
export function Root({ children }: { children?: ReactNode }): JSX.Element {
  const {
    connectors: { connect },
  } = useNode();
  return (
    <div ref={(el) => { if (el) connect(el); }} data-testid="c4builder-canvas" style={{ minHeight: 80, padding: 4 }}>
      {children}
    </div>
  );
}
Root.craft = { displayName: "Root" };

export function Opaque({ raw }: { raw?: string }): JSX.Element {
  const { ref, selected } = useCraftBox();
  return (
    <div ref={ref} data-testid="c4node-Opaque" style={{ ...selectableStyle(selected), fontFamily: "monospace", fontSize: 11, color: "var(--mantine-color-dimmed)", whiteSpace: "pre-wrap" }}>
      {raw || "…"}
    </div>
  );
}
Opaque.craft = { displayName: "Opaque" };

export const resolver = { Root, Stack, Group, Heading, Text, Button, Opaque };
