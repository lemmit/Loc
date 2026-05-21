import { useMemo, useState } from "react";
import { Box, Text } from "@mantine/core";
import { AstUtils } from "langium";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { BodyProp, Page } from "../../../src/language/generated/ast.js";
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
interface PageEntry {
  name: string;
  body: BodyProp;
}

function collectPages(ast: unknown): PageEntry[] {
  const out: PageEntry[] = [];
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type !== "Page") continue;
    const page = node as Page;
    const body = page.props.find((p): p is BodyProp => p.$type === "BodyProp");
    if (body) out.push({ name: page.name, body });
  }
  return out;
}

// Typed option sets for `ref` props (drives the binding dropdowns).
function collectOptions(ast: unknown): Record<string, string[]> {
  const aggregate = new Set<string>();
  for (const node of AstUtils.streamAst(ast as Parameters<typeof AstUtils.streamAst>[0])) {
    if (node.$type === "Aggregate") aggregate.add((node as unknown as { name: string }).name);
  }
  return { aggregate: [...aggregate].sort() };
}

export default function BuilderPane({ ctx }: { ctx: LayoutCtx }): JSX.Element {
  // Bumped on Apply to re-read the (mutated) source and re-seed the canvas.
  const [rev, setRev] = useState(0);
  const parsed = useMemo(() => parseDdd(ctx.getSource()), [ctx, rev]);
  const pages = useMemo(() => collectPages(parsed.ast), [parsed]);
  const options = useMemo(() => collectOptions(parsed.ast), [parsed]);

  const [pageName, setPageName] = useState<string>("");
  const current = pages.find((p) => p.name === pageName) ?? pages[0];

  const initialNodes = useMemo<SerializedNodes | null>(
    () => (current ? toCraft(seedFromBody(current.body.expr)) : null),
    [current],
  );

  if (parsed.parserErrors.length > 0) {
    return <Message>Source has syntax errors — fix them in the editor to use the builder.</Message>;
  }
  if (!current || !initialNodes) {
    return <Message>No <code>page</code> with a <code>body:</code> found. Add a <code>ui {"{ page { … } }"}</code> block.</Message>;
  }

  const handleApply = (nodes: SerializedNodes): void => {
    const source = ctx.getSource();
    const fresh = parseDdd(source);
    const page = collectPages(fresh.ast).find((p) => p.name === current.name);
    if (!page) return;
    const emitted = emitBody(fromCraft(nodes));
    ctx.onSourceChange(spliceNode(source, page.body.expr, emitted), "builder");
    setRev((r) => r + 1);
  };

  return (
    <PageBuilder
      key={`${current.name}:${rev}`}
      initialNodes={initialNodes}
      pages={pages.map((p) => p.name)}
      pageName={current.name}
      options={options}
      onSelectPage={setPageName}
      onApply={handleApply}
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
