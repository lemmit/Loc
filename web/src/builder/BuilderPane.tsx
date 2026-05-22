import { useMemo, useState } from "react";
import { Box, Group, Text } from "@mantine/core";
import { AstUtils } from "langium";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { BodyProp, Component, Expression, Page } from "../../../src/language/generated/ast.js";
import { parseDdd } from "./parse";
import { spliceNode } from "./edit-engine";
import { seedFromBody, emitBody, type BuilderNode } from "./page/model";
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
      out.push({ name: (node as Component).name, expr: (node as Component).body });
    }
  }
  return out;
}

// Typed option sets for `ref` props (drives the binding dropdowns).  `operation`
// is contextual (depends on a node's sibling `of:`) so it's collected separately.
function collectOptions(ast: unknown): Record<string, string[]> {
  const aggregate = new Set<string>();
  const workflow = new Set<string>();
  const view = new Set<string>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Aggregate") aggregate.add((node as unknown as { name: string }).name);
    else if (node.$type === "Workflow") workflow.add((node as unknown as { name: string }).name);
    else if (node.$type === "View") view.add((node as unknown as { name: string }).name);
  }
  return { aggregate: [...aggregate].sort(), workflow: [...workflow].sort(), view: [...view].sort() };
}

// Operation names per aggregate — drives the contextual `op:` dropdown on a Form
// (its options follow the Form's selected `of:` aggregate).
function collectOperations(ast: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type !== "Operation") continue;
    const agg = (node as unknown as { $container?: { $type?: string; name?: string } }).$container;
    if (agg?.$type === "Aggregate" && agg.name) (out[agg.name] ??= []).push((node as unknown as { name: string }).name);
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

// Mark each builder node that *owns* a diagnostic (the deepest node whose
// recorded source range — `__range` — contains it) with a `__diag` message, so
// the canvas can outline the offending node.
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

export default function BuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // Bumped on Apply to re-read the (mutated) source and re-seed the canvas.
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const pages = useMemo(() => collectBodies(parsed.ast), [parsed]);
  const options = useMemo(() => collectOptions(parsed.ast), [parsed]);
  const operations = useMemo(() => collectOperations(parsed.ast), [parsed]);
  const components = useMemo(() => collectComponents(parsed.ast), [parsed]);
  const componentNames = useMemo(() => [...components.keys()].sort(), [components]);
  const stateTypes = useMemo(() => availableTypes(parsed.ast), [parsed]);

  // Apply a source-level state edit (splice) and re-seed, like handleApply.
  const applyState = (next: string | null): void => {
    if (next == null) return;
    ctx.onSourceChange(next, "builder");
    setRev((r) => r + 1);
  };

  const [pageName, setPageName] = useState<string>("");
  const current = pages.find((p) => p.name === pageName) ?? pages[0];

  // LSP diagnostics that fall within the current body's source range — surfaced
  // on the canvas so the builder flags problems without leaving for the
  // Problems panel.
  const bodyDiagnostics = useMemo(() => {
    const r = current?.expr.$cstNode?.range;
    if (!r) return [];
    return ctx.diagnostics.filter((d) => d.range.start.line <= r.end.line && d.range.end.line >= r.start.line);
  }, [ctx.diagnostics, current]);

  const initialNodes = useMemo<SerializedNodes | null>(
    () => {
      if (!current) return null;
      const tree = seedFromBody(current.expr, components);
      annotateDiagnostics(tree, bodyDiagnostics);
      return toCraft(tree);
    },
    [current, components, bodyDiagnostics],
  );

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
          <StatePanel page={current.page} getSource={() => ctx.getSource()} types={stateTypes} onApply={applyState} />
        </Group>
      )}
      <Box style={{ flex: 1, minHeight: 0 }}>
        <PageBuilder
          key={`${current.name}:${rev}`}
          initialNodes={initialNodes}
          pages={pages.map((p) => p.name)}
          pageName={current.name}
          options={options}
          operations={operations}
          componentNames={componentNames}
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
