import { useMemo, useRef, useState } from "react";
import { Box, Group, Text } from "@mantine/core";
import { AstUtils } from "langium";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { Component, EnumDecl } from "../../../src/language/generated/ast.js";
import { isAggregate, isOperation, isPage, isWorkflow } from "../../../src/language/generated/ast.js";
import { parseDdd } from "./parse";
import { ifParses, spliceNodeIfParses } from "./edit-engine";
import { RefusalLine, useRefusal } from "./refusal";
import { useLiveSourceTick } from "./use-live-source-tick";
import { collectBodies } from "./page/bodies";
import { seedFromBody, emitBody, enumStateFields, type BuilderNode } from "./page/model";
import { toCraft, fromCraft } from "./page/serialize";
import { availableTypes } from "./system/fields";
import PageBuilder from "./page/PageBuilder";
import StatePanel from "./page/StatePanel";

// Bridges the craft.js page builder to the `.ddd` source: parses the current
// source, seeds the canvas from a chosen page's `body:`, and on "Apply"
// regenerates that body and splices it back (preserving everything else).
//
// Apply tags the edit as "builder" origin so it's pushed back into the live
// Monaco model + LSP (source tab and Problems panel reflect it immediately),
// then re-seeds the canvas so the change persists visibly here too.
// Typed option sets for `ref` props (drives the binding dropdowns).  `operation`
// is contextual (depends on a node's sibling `of:`) so it's collected separately.
function collectOptions(ast: unknown): Record<string, string[]> {
  const aggregate = new Set<string>();
  const workflow = new Set<string>();
  const page = new Set<string>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (isAggregate(node)) aggregate.add(node.name);
    else if (isWorkflow(node)) workflow.add(node.name);
    else if (isPage(node)) page.add(node.name);
  }
  return { aggregate: [...aggregate].sort(), workflow: [...workflow].sort(), page: [...page].sort() };
}

// Operation names per aggregate — drives the contextual `op:` dropdown on a Form
// (its options follow the Form's selected `of:` aggregate).
function collectOperations(ast: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (!isOperation(node)) continue;
    const agg = AstUtils.getContainerOfType(node, isAggregate);
    if (agg) (out[agg.name] ??= []).push(node.name);
  }
  return out;
}

// User-defined `component`s in scope, mapped to their declared param names — a
// call to one is recognised as an editable node (positional args become props
// labelled by param name) rather than Opaque source.
function collectComponents(ast: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Component") {
      const c = node as Component;
      out.set(c.name, (c.params ?? []).map((p) => p.name));
    }
  }
  return out;
}

// Enum cases per enum name — drives the enum-case dropdown for an enum-typed
// state field's default in the State panel.
function collectEnums(ast: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "EnumDecl") {
      const e = node as EnumDecl;
      out.set(e.name, (e.values ?? []).map((v) => v.name));
    }
  }
  return out;
}


function annotateDiagnostics(tree: BuilderNode, diagnostics: readonly { range: { start: { line: number; character: number }; end: { line: number; character: number } }; message: string }[]): void {
  const after = (al: number, ac: number, bl: number, bc: number): boolean => al > bl || (al === bl && ac >= bc);
  const ownerOf = (node: BuilderNode, dStart: { line: number; character: number }, dEnd: { line: number; character: number }): BuilderNode | null => {
    const raw = node.props.__range;
    if (typeof raw !== "string") {
      for (const c of node.children) { const o = ownerOf(c, dStart, dEnd); if (o) return o; }
      return null;
    }
    const [sl, sc, el, ec] = raw.split(",").map(Number);
    if (!(after(dStart.line, dStart.character, sl, sc) && after(el, ec, dEnd.line, dEnd.character))) return null;
    for (const c of node.children) { const o = ownerOf(c, dStart, dEnd); if (o) return o; }
    return node;
  };
  for (const d of diagnostics) {
    const owner = ownerOf(tree, d.range.start, d.range.end);
    if (owner) owner.props.__diag = owner.props.__diag ? `${owner.props.__diag}; ${d.message}` : d.message;
  }
}

/** Stable string describing which nodes of a serialized seed carry a
 *  `__diag` annotation (and what it says).  `""` when none do — the common
 *  case, which keeps the canvas mount key still. */
function diagSignature(nodes: SerializedNodes | null): string {
  if (!nodes) return "";
  const parts: string[] = [];
  for (const [id, node] of Object.entries(nodes)) {
    const diag = (node as { props?: Record<string, unknown> }).props?.__diag;
    if (typeof diag === "string" && diag !== "") parts.push(`${id}=${diag}`);
  }
  return parts.sort().join("|");
}

export default function BuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // Bumped on Apply to re-read the (mutated) source and re-seed the canvas.
  const [rev, setRev] = useState(0);
  // Debounced mirror of `ctx.editorSourceTick` — bumped after the user has
  // stopped typing.  Separate from `rev` (the Apply-path counter that fully
  // remounts the craft Editor); the live path must NOT remount or the user's
  // selection / open inputs would tear down.  See `use-live-source-tick.ts`
  // for the baseline rule (the first tick a pane sees is not a change).
  const liveTick = useLiveSourceTick(ctx.editorSourceTick);
  // `rev` re-reads on Apply; `liveTick` re-reads on the debounced editor
  // change (in-place re-seed inside PageBuilder).  Don't depend on `ctx`
  // here — re-parsing on every render makes `liveNodes` a new reference each
  // time, which would echo into a deserialize that clobbers the user's
  // in-flight settings-panel edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [rev, liveTick]);
  const pages = useMemo(() => collectBodies(parsed.ast), [parsed]);
  const options = useMemo(() => collectOptions(parsed.ast), [parsed]);
  const operations = useMemo(() => collectOperations(parsed.ast), [parsed]);
  const components = useMemo(() => collectComponents(parsed.ast), [parsed]);
  const componentNames = useMemo(() => [...components.keys()].sort(), [components]);
  const stateTypes = useMemo(() => availableTypes(parsed.ast), [parsed]);
  const enumCases = useMemo(() => collectEnums(parsed.ast), [parsed]);
  const refusal = useRefusal();

  // Apply a source-level state edit (splice) and re-seed, like handleApply.
  // The State panel's helpers splice a reprinted `state { … }` block; a bad
  // reprint would otherwise commit a source the builder itself can't reopen,
  // so the candidate is re-parsed here before it reaches the editor.
  const applyState = (next: string | null): void => {
    // null here means the helper found nothing to edit — not a refusal.
    if (next == null) return;
    if (ifParses(next) == null) {
      refusal.refuse();
      return;
    }
    refusal.clear();
    ctx.onSourceChange(next, "builder");
    setRev((r) => r + 1);
  };

  const [pageName, setPageName] = useState<string>("");
  const current = pages.find((p) => p.name === pageName) ?? pages[0];

  // Local enum-type inference for assignment values: { stateFieldName → enumName }
  // for the current page's enum-typed state fields. Empty when the body is a
  // `component` (no `state {}` block) or no state field is enum-typed.
  const pageEnumFields = useMemo(
    () => (current?.page ? enumStateFields(current.page, enumCases) : new Map<string, string>()),
    [current, enumCases],
  );

  // LSP diagnostics that fall within the current body's source range — surfaced
  // on the canvas so the builder flags problems without leaving for the
  // Problems panel.
  const bodyDiagnostics = useMemo(() => {
    // `expr` can be undefined on a recovered AST — the `?.` has to guard it,
    // not just `current`.
    const r = current?.expr?.$cstNode?.range;
    if (!r) return [];
    return ctx.diagnostics.filter((d) => d.range.start.line <= r.end.line && d.range.end.line >= r.start.line);
  }, [ctx.diagnostics, current]);

  // The canvas seed for the *current* parse.  Diagnostics are annotated
  // afterwards on a clone — we deliberately keep them **out** of the
  // memo's dependency set so the seed's reference is stable across
  // diagnostic refreshes (which the LSP runs out-of-band of source
  // changes).  Otherwise every diagnostic refresh would cause the
  // LiveSync deserialize to fire and clobber the user's in-flight
  // settings-panel edits.
  const seedNodes = useMemo<SerializedNodes | null>(
    () => {
      if (!current?.expr) return null;
      return toCraft(seedFromBody(current.expr, components));
    },
    [current, components],
  );
  // Diagnostics overlay — annotate a separate copy so it doesn't disturb
  // the canonical seed.  `initialNodes` (below) is what `<Frame>` consumes,
  // and craft only honours its initial value, so a diagnostic-only refresh
  // can't reach the canvas through the data prop — `diagKey` below carries it
  // into the mount key instead.
  const annotatedNodes = useMemo<SerializedNodes | null>(
    () => {
      if (!current?.expr || !seedNodes) return null;
      const tree = seedFromBody(current.expr, components);
      annotateDiagnostics(tree, bodyDiagnostics);
      return toCraft(tree);
    },
    [current, components, seedNodes, bodyDiagnostics],
  );
  // Which nodes of the annotated seed actually carry a diagnostic.  The
  // per-node outlines are baked into the seed at MOUNT, and diagnostics arrive
  // out-of-band of the parse (LSP round-trip) — so a warning that lands after
  // the mount, or one whose range only lines up with the seed a re-emit later,
  // would otherwise never reach the canvas at all: the problems bar showed it
  // and the node stayed unmarked, permanently.  Folding the annotation set into
  // the mount key re-bakes the seed exactly when it changes.  It is derived
  // from the ATTACHED annotations, not from `ctx.diagnostics`, so an unmapped
  // or unchanged diagnostic set leaves the key alone and the canvas mounted.
  const diagKey = useMemo(() => diagSignature(annotatedNodes), [annotatedNodes]);

  // `initialNodes` is the **first** seed for the current Editor mount (i.e.
  // the current page + Apply-rev + annotation triple).  It's what
  // `<Frame data={...}>` consumes; craft ignores subsequent `data` changes, so
  // a live re-seed can't go through here — see `liveNodes` below.  We snapshot
  // the first non-null annotated seed per key and pin it via a ref so live
  // updates don't bleed into the Frame's data and trigger a Frame remount.
  const mountKey = `${current?.name ?? ""}:${rev}:${diagKey}`;
  const initialNodesRef = useRef<{ key: string; nodes: SerializedNodes } | null>(null);
  if (annotatedNodes && initialNodesRef.current?.key !== mountKey) {
    initialNodesRef.current = { key: mountKey, nodes: annotatedNodes };
  }
  const initialNodes = initialNodesRef.current?.key === mountKey ? initialNodesRef.current.nodes : null;
  // `liveNodes` is the *current* seed (no diagnostic overlay — see the
  // memo above), refreshed only when the source actually changed.  Passed
  // to PageBuilder's `LiveSync` child, which calls
  // `actions.deserialize(...)` in-place (preserving the user's selection
  // across the re-seed).
  //
  // `liveNodes` follows `seedNodes` once any source change has landed
  // after mount; until then it points at `initialNodes` so a deserialize
  // can't fire spuriously.  The `firstSeenTickRef` guard above ensures
  // the first liveTick bump after mount is one we actually want.
  const liveNodes = liveTick > 0 ? seedNodes : initialNodes;

  if (parsed.parserErrors.length > 0) {
    return <Message>Source has syntax errors — fix them in the editor to use the builder.</Message>;
  }
  if (!current || !initialNodes) {
    return <Message>No <code>page</code> or <code>component</code> with a <code>body:</code> found. Add a <code>ui {"{ page { … } }"}</code> block.</Message>;
  }

  // `source` is read ONCE and everything downstream — the parse that locates
  // the page, the splice, and the re-parse that validates it — runs against
  // that same snapshot.  The canvas is seeded off a 350 ms-debounced parse, so
  // `ctx.getSource()` can have drifted from what the user sees; re-reading it
  // between validate and commit would reopen exactly that window.
  const handleApply = (nodes: SerializedNodes): void => {
    const source = ctx.getSource();
    const fresh = parseDdd(source);
    const page = collectBodies(fresh.ast).find((p) => p.name === current.name);
    if (!page) return;
    const emitted = emitBody(fromCraft(nodes));
    const next = spliceNodeIfParses(source, page.expr, emitted);
    if (next == null) {
      refusal.refuse();
      return;
    }
    refusal.clear();
    ctx.onSourceChange(next, "builder");
    setRev((r) => r + 1);
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {ctx.isDesktop && current.page && (
        <Group px="xs" py={4} bg="dark.7" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
          <StatePanel page={current.page} getSource={() => ctx.getSource()} types={stateTypes} enumCases={enumCases} onApply={applyState} />
        </Group>
      )}
      <RefusalLine refused={refusal.refused} />
      <Box style={{ flex: 1, minHeight: 0 }}>
        <PageBuilder
          // `mountKey` (page : Apply-rev : annotation-set) — remounting the
          // craft Editor is the only way a freshly annotated seed reaches
          // `<Frame data>`, which craft reads once.
          key={mountKey}
          initialNodes={initialNodes}
          liveNodes={liveNodes ?? initialNodes}
          pages={pages.map((p) => p.name)}
          pageName={current.name}
          options={options}
          operations={operations}
          componentNames={componentNames}
          enumCases={enumCases}
          pageEnumFields={pageEnumFields}
          diagnostics={bodyDiagnostics}
          onSelectPage={setPageName}
          onApply={handleApply}
          compact={!ctx.isDesktop}
        />
      </Box>
    </Box>
  );
}

function Message({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Box p="md">
      <Text size="sm" c="dimmed">{children}</Text>
    </Box>
  );
}
