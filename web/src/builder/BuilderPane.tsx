import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Group, Text } from "@mantine/core";
import { AstUtils } from "langium";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { BodyProp, Component, EnumDecl, Expression, Page } from "../../../src/language/generated/ast.js";
import { isAggregate, isOperation, isPage, isWorkflow } from "../../../src/language/generated/ast.js";
import { parseDdd } from "./parse";
import { spliceNode } from "./edit-engine";
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
interface BodyEntry {
  name: string;
  /** The body expression (its CST range is the splice target). */
  expr: Expression;
  /** The owning `Page` (absent for `component` bodies) — drives the state editor. */
  page?: Page;
}

// Every editable body: a `page`'s `body:` and a `component`'s `body:` both
// project a single expression onto the canvas.
function collectBodies(ast: unknown): BodyEntry[] {
  const out: BodyEntry[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Page") {
      const body = (node as Page).props.find((p): p is BodyProp => p.$type === "BodyProp");
      if (body) out.push({ name: (node as Page).name, expr: body.expr, page: node as Page });
    } else if (node.$type === "Component") {
      // Extern components have no `body:` (their rendering lives in a
      // hand-written module), so there's nothing to project onto the canvas.
      const comp = node as Component;
      if (comp.body) out.push({ name: comp.name, expr: comp.body });
    }
  }
  return out;
}

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
      out.set(c.name, c.params.map((p) => p.name));
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
      out.set(e.name, e.values.map((v) => v.name));
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

// Debounce window for the text→canvas live re-seed.  300ms is the lower
// bound the task gave; long enough to coalesce a typing storm in Monaco,
// short enough that an edit feels "live" to the user watching the canvas.
const LIVE_SYNC_DEBOUNCE_MS = 350;

export default function BuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // Bumped on Apply to re-read the (mutated) source and re-seed the canvas.
  const [rev, setRev] = useState(0);
  // Debounced mirror of `ctx.editorSourceTick`.  Bumped after the user
  // has stopped typing for `LIVE_SYNC_DEBOUNCE_MS`; that drives the live
  // canvas re-seed (separate from `rev`, which is the Apply-path counter
  // that fully remounts the craft Editor — the live path mustn't remount,
  // or the user's selection / open inputs would tear down).
  //
  // The very first editor tick observed by this BuilderPane instance is
  // captured in `firstSeenTickRef` and ignored: the initial canvas seed
  // already reflects whatever source the user typed before opening the
  // builder, so re-running the seed on that pre-mount tick would clobber
  // a selection / settings-panel edit the user started during the
  // debounce window after switching tabs.  Only ticks that *advance*
  // beyond that baseline schedule a re-seed.
  const [liveTick, setLiveTick] = useState(0);
  const firstSeenTickRef = useRef<number | null>(null);
  useEffect(() => {
    if (firstSeenTickRef.current === null) {
      firstSeenTickRef.current = ctx.editorSourceTick;
      return;
    }
    if (ctx.editorSourceTick <= firstSeenTickRef.current) return;
    const t = window.setTimeout(() => setLiveTick((n) => n + 1), LIVE_SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [ctx.editorSourceTick]);
  // `rev` re-reads on Apply (full remount); `liveTick` re-reads on the
  // debounced editor change (in-place re-seed inside PageBuilder).  Don't
  // depend on `ctx` here — ctx is a fresh object every App render, but the
  // underlying source only changes when one of these counters bumps, and
  // re-parsing on every render makes `liveNodes` a new reference each
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

  // Apply a source-level state edit (splice) and re-seed, like handleApply.
  const applyState = (next: string | null): void => {
    if (next == null) return;
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
    const r = current?.expr.$cstNode?.range;
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
      if (!current) return null;
      return toCraft(seedFromBody(current.expr, components));
    },
    [current, components],
  );
  // Diagnostics overlay — annotate a separate copy so it doesn't disturb
  // the canonical seed.  `initialNodes` (below) is what `<Frame>` consumes,
  // and craft only honours its initial value, so a diagnostic-only refresh
  // doesn't reach the canvas — that's acceptable: the diagnostics bar at
  // the top of the canvas (separate component) updates immediately, and
  // per-node red outlines surface on the next live re-seed / Apply.
  const annotatedNodes = useMemo<SerializedNodes | null>(
    () => {
      if (!current || !seedNodes) return null;
      const tree = seedFromBody(current.expr, components);
      annotateDiagnostics(tree, bodyDiagnostics);
      return toCraft(tree);
    },
    [current, components, seedNodes, bodyDiagnostics],
  );

  // `initialNodes` is the **first** seed for the current Editor mount (i.e.
  // the current page + Apply-rev pair).  It's what `<Frame data={...}>`
  // consumes; craft ignores subsequent `data` changes, so a live re-seed
  // can't go through here — see `liveNodes` below.  We snapshot the very
  // first non-null annotated seed and pin it via a ref so live updates
  // don't bleed into the Frame's data and trigger a Frame remount.
  const mountKey = `${current?.name ?? ""}:${rev}`;
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

  const handleApply = (nodes: SerializedNodes): void => {
    const source = ctx.getSource();
    const fresh = parseDdd(source);
    const page = collectBodies(fresh.ast).find((p) => p.name === current.name);
    if (!page) return;
    const emitted = emitBody(fromCraft(nodes));
    ctx.onSourceChange(spliceNode(source, page.expr, emitted), "builder");
    setRev((r) => r + 1);
  };

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {ctx.isDesktop && current.page && (
        <Group px="xs" py={4} bg="dark.7" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
          <StatePanel page={current.page} getSource={() => ctx.getSource()} types={stateTypes} enumCases={enumCases} onApply={applyState} />
        </Group>
      )}
      <Box style={{ flex: 1, minHeight: 0 }}>
        <PageBuilder
          key={`${current.name}:${rev}`}
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
