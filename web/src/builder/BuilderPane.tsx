import { useMemo, useState } from "react";
import { Box, Text } from "@mantine/core";
import { AstUtils } from "langium";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { BodyProp, Component, Expression, Page } from "../../../src/language/generated/ast.js";
import { parseDdd } from "./parse";
import { spliceNode } from "./edit-engine";
import { seedFromBody, emitBody } from "./page/model";
import { toCraft, fromCraft } from "./page/serialize";
import PageBuilder from "./page/PageBuilder";

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
}

// Every editable body: a `page`'s `body:` and a `component`'s `body:` both
// project a single expression onto the canvas.
function collectBodies(ast: unknown): BodyEntry[] {
  const out: BodyEntry[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Page") {
      const body = (node as Page).props.find((p): p is BodyProp => p.$type === "BodyProp");
      if (body) out.push({ name: (node as Page).name, expr: body.expr });
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

// Names of user-defined `component`s in scope — a call to one is recognised as
// an editable node rather than Opaque source.
function collectComponents(ast: unknown): Set<string> {
  const out = new Set<string>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Component") out.add((node as Component).name);
  }
  return out;
}

export default function BuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // Bumped on Apply to re-read the (mutated) source and re-seed the canvas.
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const pages = useMemo(() => collectBodies(parsed.ast), [parsed]);
  const options = useMemo(() => collectOptions(parsed.ast), [parsed]);
  const operations = useMemo(() => collectOperations(parsed.ast), [parsed]);
  const components = useMemo(() => collectComponents(parsed.ast), [parsed]);
  const componentNames = useMemo(() => [...components].sort(), [components]);

  const [pageName, setPageName] = useState<string>("");
  const current = pages.find((p) => p.name === pageName) ?? pages[0];

  const initialNodes = useMemo<SerializedNodes | null>(
    () => (current ? toCraft(seedFromBody(current.expr, components)) : null),
    [current, components],
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
    <PageBuilder
      key={`${current.name}:${rev}`}
      initialNodes={initialNodes}
      pages={pages.map((p) => p.name)}
      pageName={current.name}
      options={options}
      operations={operations}
      componentNames={componentNames}
      onSelectPage={setPageName}
      onApply={handleApply}
      compact={!ctx.isDesktop}
    />
  );
}

function Message({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Box p="md">
      <Text size="sm" c="dimmed">{children}</Text>
    </Box>
  );
}
