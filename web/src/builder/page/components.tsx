import type { ComponentType, ElementType, ReactNode } from "react";
import { useNode } from "@craftjs/core";
import { PRIMITIVES, isContainer, propFields, type PrimitiveName } from "./model";

// craft.js User Components for the page-builder primitives.  Each renders a
// lightweight structural stand-in (not the real design-pack output — the canvas
// is a structural editor, not a live preview) and wires craft's connect/drag so
// nodes are selectable, draggable, and droppable.

type Props = Record<string, string | number | undefined>;

function useBox(): { ref: (el: HTMLElement | null) => void; selected: boolean; props: Props } {
  const {
    connectors: { connect, drag },
    selected,
    props,
  } = useNode((state) => ({ selected: state.events.selected, props: state.data.props as Props }));
  return { ref: (el) => { if (el) connect(drag(el)); }, selected, props };
}

const boxStyle = (selected: boolean, errored = false): React.CSSProperties => ({
  outline: errored
    ? "2px solid var(--mantine-color-red-6)"
    : selected
      ? "2px solid var(--mantine-color-blue-5)"
      : "1px dashed var(--mantine-color-dark-3)",
  borderRadius: 4,
  padding: 6,
  margin: 2,
  cursor: "move",
});

const pill = (text: string, bg: string): JSX.Element => (
  <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 4, background: bg, color: "white" }}>{text}</span>
);

// Display a stored prop value on the canvas: unquote a bare string literal
// (props store the source form, e.g. `"hi"`), show an expression as-is.
function disp(v: string | number | undefined): string {
  if (v === undefined) return "";
  const s = String(v);
  try {
    const parsed = JSON.parse(s);
    if (typeof parsed === "string" && JSON.stringify(parsed) === s) return parsed;
  } catch {
    /* not a string literal — show verbatim */
  }
  return s;
}

function renderLeaf(name: PrimitiveName, p: Props): ReactNode {
  switch (name) {
    case "Divider":
      return <div style={{ borderTop: "1px solid var(--mantine-color-dark-3)", height: 0 }} />;
    case "Heading":
      return <span style={{ fontWeight: 700, fontSize: 22 - (Number(p.level ?? 2) - 1) * 2 }}>{disp(p.text) || "Heading"}</span>;
    case "Text":
      return <span>{disp(p.text) || "Text"}</span>;
    case "Empty":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>{disp(p.message) || "Empty"}</span>;
    case "Alert":
      return <div style={{ padding: "4px 8px", borderRadius: 4, background: "var(--mantine-color-red-9)", color: "white" }}>{disp(p.message) || "Alert"}</div>;
    case "Badge":
      return pill(disp(p.value) || "Badge", "var(--mantine-color-grape-7)");
    case "Button":
      return pill((disp(p.label) || "Button") + (p.to ? ` →${disp(p.to)}` : ""), "var(--mantine-color-blue-7)");
    case "Anchor":
      return <a style={{ color: "var(--mantine-color-blue-4)" }}>{disp(p.text) || "Anchor"}{p.to ? ` →${disp(p.to)}` : ""}</a>;
    case "List":
      return <span style={{ color: "var(--mantine-color-teal-4)" }}>⊟ List{p.of ? ` of ${p.of}` : ""}</span>;
    case "Form":
      return <span style={{ color: "var(--mantine-color-teal-4)" }}>▤ Form{p.of ? ` of ${p.of}` : p.creates ? ` creates ${p.creates}` : ""}</span>;
    case "Stat":
      return <span><b>{disp(p.label) || "Stat"}</b>: {disp(p.value)}</span>;
    case "Money":
      return <span>{disp(p.value) || "Money"}</span>;
    case "DateDisplay":
      return <span style={{ color: "var(--mantine-color-dimmed)" }}>{disp(p.value) || "date"}</span>;
    case "EnumBadge":
      return pill(disp(p.value) || "enum", "var(--mantine-color-grape-7)");
    case "IdLink":
      return <a style={{ color: "var(--mantine-color-blue-4)" }}>{disp(p.id) || "id"}{p.of ? ` → ${disp(p.of)}` : ""}</a>;
    case "Image":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>image{p.src ? ` ${p.src}` : ""}</span>;
    case "Avatar":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>avatar</span>;
    case "Loader":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>Loader…</span>;
    case "Skeleton":
      return <span style={{ fontStyle: "italic", color: "var(--mantine-color-dimmed)" }}>Skeleton{p.count ? ` ×${p.count}` : ""}</span>;
    case "Slot":
      return <span style={{ fontFamily: "monospace" }}>{"{slot}"}</span>;
    case "Field":
    case "NumberField":
    case "PasswordField":
      return <span>{disp(p.label) || name}: <span style={{ display: "inline-block", minWidth: 48, borderBottom: "1px solid var(--mantine-color-dark-3)" }} /></span>;
    case "Toggle":
      return <span>◯ {disp(p.label) || "Toggle"}</span>;
    case "Stmt":
      return <span style={{ fontFamily: "monospace", fontSize: 11 }}>{String(p.src || "…")}</span>;
    default:
      return String(name);
  }
}

function makeContainer(name: PrimitiveName): ComponentType<{ children?: ReactNode }> {
  const propKeys = propFields(name).map((f) => f.key);
  const C = ({ children }: { children?: ReactNode }): JSX.Element => {
    const { ref, selected, props } = useBox();
    const extras = propKeys
      .map((k) => props[k])
      .filter((v) => v !== undefined && v !== "")
      .map(String);
    const diag = props.__diag ? String(props.__diag) : undefined;
    return (
      <div ref={ref} data-testid={`c4node-${name}`} title={diag} data-diag={diag ? "1" : undefined} style={{ ...boxStyle(selected, diag != null), background: "var(--mantine-color-dark-6)" }}>
        <div style={{ fontSize: 10, color: "var(--mantine-color-dimmed)", marginBottom: 4 }}>
          {extras.length ? `${name}: ${extras.join(" · ")}` : name}
        </div>
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
  // A leaf may still carry slot children — e.g. an event-handler lambda
  // (`Button(onClick: e => …)`).  craft passes those as React `children` when the
  // node is a canvas (it is, once it has children), so render them below the
  // leaf's own content.
  const C = ({ children, ...props }: Props & { children?: ReactNode }): JSX.Element => {
    const { ref, selected } = useBox();
    const diag = props.__diag ? String(props.__diag) : undefined;
    return (
      <div ref={ref} data-testid={`c4node-${name}`} title={diag} data-diag={diag ? "1" : undefined} style={boxStyle(selected, diag != null)}>
        {renderLeaf(name, props as Props)}
        {children}
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
  const { ref, selected, props } = useBox();
  const diag = props.__diag ? String(props.__diag) : undefined;
  return (
    <div ref={ref} data-testid="c4node-Opaque" title={diag} data-diag={diag ? "1" : undefined} style={{ ...boxStyle(selected, diag != null), fontFamily: "monospace", fontSize: 11, color: "var(--mantine-color-dimmed)", whiteSpace: "pre-wrap" }}>
      {raw || "…"}
    </div>
  );
}
Opaque.craft = { displayName: "Opaque" };

// Resolver: Root + Opaque + one component per registered primitive + the
// synthetic container nodes (lambda / match), which aren't in the palette but
// must be resolvable + editable when seeded from source.
export const resolver: Record<string, ElementType> = { Root, Opaque };
for (const name of PRIMITIVES) {
  resolver[name] = isContainer(name) ? makeContainer(name) : makeLeaf(name);
}
for (const name of ["Lambda", "Match", "MatchArm", "MatchElse"] as const) {
  resolver[name] = makeContainer(name);
}
resolver.Stmt = makeLeaf("Stmt" as PrimitiveName);

// Build a resolver that also knows the current source's user-defined
// `component` calls (each rendered as a container box labelled with its name).
// craft resolves nodes by their exact `resolvedName`, so the dynamic component
// names must be registered before the canvas seeds.
export function resolverWithComponents(componentNames: readonly string[]): Record<string, ElementType> {
  const r: Record<string, ElementType> = { ...resolver };
  for (const name of componentNames) if (!r[name]) r[name] = makeContainer(name as PrimitiveName);
  return r;
}
