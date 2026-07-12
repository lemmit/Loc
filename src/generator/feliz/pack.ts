// Minimal PROCEDURAL Feliz design pack (fable-elmish-frontend.md §4).
//
// The Handlebars pack format emits markup STRINGS; Feliz "markup" is F# code
// (`Html.div [ … ]`), so the spike chose procedural emission over templates.
// This is a `LoadedPack` whose `render(name, ctx)` dispatches to per-primitive
// F#-emitting functions instead of compiled templates.  It starts with the
// handful of primitives the first example needs and grows example-by-example —
// NOT all ~80.  A missing primitive returns a visible `(* … *)` comment.

import type { LoadedPack } from "../_packs/loader.js";

type Ctx = Record<string, string | number | boolean | undefined>;

/** Wrap a walker-produced text field as a Feliz CHILD element.  The walker
 *  hands text as either a raw string literal (`Counter`) or an already-rendered
 *  interpolation (`Html.text (string …)`); a child slot needs `Html.text` for
 *  the former and the expression verbatim for the latter. */
function asChild(text: string | undefined): string {
  const s = (text ?? "").trim();
  if (s.startsWith("Html.") || s.startsWith("(")) return s;
  return `Html.text "${s}"`;
}

function primitiveStack(c: Ctx): string {
  if (!c.hasChildren) return "Html.div []";
  // The walker joins children with `\n${indent}` — so the FIRST child carries
  // no leading indent while its siblings do.  F# lists are offside-sensitive:
  // every element must share a column, so prefix the first child with the same
  // `indent` the join used.  (Later multi-line children keep their own internal
  // indentation, which is already self-consistent.)
  const indent = String(c.indent ?? "  ");
  const children = `${indent}${String(c.childrenBlock ?? "")}`;
  return `Html.div [\n  prop.children [\n${children}\n  ]\n]`;
}

function primitiveHeading(c: Ctx): string {
  const level = Number(c.level ?? 2);
  const tag = level >= 1 && level <= 6 ? `h${level}` : "h2";
  return `Html.${tag} [ ${asChild(String(c.text ?? ""))} ]`;
}

function primitiveText(c: Ctx): string {
  return `Html.p [ ${asChild(String(c.text ?? ""))} ]`;
}

function primitiveCard(c: Ctx): string {
  // Card("title", content) — an optional heading + a single content element.
  const kids: string[] = [];
  if (c.hasTitle) kids.push(`Html.h3 [ ${asChild(String(c.titleText ?? ""))} ]`);
  if (c.hasContent) kids.push(String(c.contentJsx ?? ""));
  const children = kids.length > 0 ? `; prop.children [ ${kids.join("; ")} ]` : "";
  return `Html.div [ prop.className "loom-card"${children} ]`;
}

function primitiveBadge(c: Ctx): string {
  const label = String(c.label ?? "").trim();
  const inner =
    label.startsWith("Html.") || label.startsWith("(")
      ? `prop.children [ ${label} ]`
      : `prop.text "${label}"`;
  return `Html.span [ prop.className "loom-badge"; ${inner} ]`;
}

function primitiveDivider(_c: Ctx): string {
  return "Html.hr []";
}

function primitiveButton(c: Ctx): string {
  // A Feliz element list is EITHER all children (ReactElement) OR all props
  // (IReactProperty) — never mixed.  A button carries an onClick prop, so the
  // label goes through a prop too: `prop.text` for a plain string, or
  // `prop.children [ … ]` when the label is an already-rendered element.
  const props: string[] = [];
  if (c.hasOnClick) props.push(`prop.onClick (${c.onClick})`);
  const label = String(c.label ?? "").trim();
  if (label.startsWith("Html.") || label.startsWith("(")) {
    props.push(`prop.children [ ${label} ]`);
  } else {
    props.push(`prop.text "${label}"`);
  }
  return `Html.button [ ${props.join("; ")} ]`;
}

const RENDERERS: Record<string, (c: Ctx) => string> = {
  "primitive-stack": primitiveStack,
  "primitive-group": primitiveStack,
  "primitive-heading": primitiveHeading,
  "primitive-text": primitiveText,
  "primitive-button": primitiveButton,
  "primitive-card": primitiveCard,
  "primitive-badge": primitiveBadge,
  "primitive-divider": primitiveDivider,
};

/** Build the procedural Feliz pack.  Implements the `LoadedPack` render
 *  contract without Handlebars — the loader's template path is unused here. */
export function felizPack(): LoadedPack {
  return {
    manifest: { name: "felizBasic", version: "v1", format: "tsx", emits: {}, imports: {} },
    rootDir: "<feliz-procedural>",
    templates: new Map(),
    render(name: string, context: unknown): string {
      const fn = RENDERERS[name];
      if (!fn) return `(* feliz pack: no renderer for "${name}" *)`;
      return fn((context ?? {}) as Ctx);
    },
  };
}
