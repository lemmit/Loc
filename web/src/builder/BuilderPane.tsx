import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Box, Button, Checkbox, Divider, Group, Popover, Select, Stack, Text, TextInput } from "@mantine/core";
import { AstUtils } from "langium";
import { NO_PAGES, SCAFFOLD } from "../layout/vocabulary";
import { listScaffoldedPages, mayHaveScaffoldedPages, unfoldScaffoldedPage, type ScaffoldedPage } from "./page/scaffold";
import { IconX } from "./icons";
import type { SerializedNodes } from "@craftjs/core";
import type { LayoutCtx } from "../layout/ctx";
import type { BodyProp, Component, EnumDecl, Expression, Page } from "../../../src/language/generated/ast.js";
import { isAggregate, isOperation, isPage, isUi, isWorkflow } from "../../../src/language/generated/ast.js";
import { parseDdd } from "./parse";
import { spliceNodeIfParses } from "./edit-engine";
import { RefusalLine } from "./refusal";
import { usePaneHarness } from "./pane-harness";
import { ConfirmAction, confirmSites, type ConfirmSpec } from "../util/confirm";
import { UndoRedo, paneUndoKeyHandler } from "./undo-redo";
import { collectBodies } from "./page/bodies";
import { seedFromBody, emitBody, enumStateFields, type BuilderNode } from "./page/model";
import { toCraft, fromCraft } from "./page/serialize";
import {
  availableLayouts,
  pageProps,
  setPageCanonical,
  setPageDescription,
  setPageLayout,
  setPageMenuMeta,
  setPageOgImage,
  setPageRequires,
  setPageRoute,
  setPageTitle,
  type PagePropsInfo,
} from "./page/page-props";
import {
  addArea,
  addMenuLink,
  addMenuSection,
  addPage,
  addStore,
  addStoreField,
  deleteMenuLink,
  deleteMenuSection,
  deleteStore,
  listAreas,
  listStores,
  menuInfo,
  menuLinkTargets,
  movePageToArea,
  setStorePersist,
  STORE_PERSIST_MODES,
  type AreaInfo,
  type AreaTree,
  type MenuInfo,
  type StoreInfo,
  type StorePersist,
} from "./page/ui-decl";
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
  // The shared safety rails (parse memo + `rev` + write gate + refusal line) —
  // see `pane-harness.ts`.  `rev` re-reads on Apply; `liveTick` re-reads on the
  // debounced editor change (in-place re-seed inside PageBuilder).
  //
  // This is the one pane that opts OUT of the external-reseed tick: a file-tab
  // switch / import remounts the craft Editor by other means, and folding that
  // tick into the parse memo would make `liveNodes` a new reference, echoing
  // into a deserialize that clobbers the user's in-flight settings-panel edits.
  const harness = usePaneHarness(ctx, { externalReseed: false });
  const { parsed, rev, refusal } = harness;
  const pages = useMemo(() => collectBodies(parsed.ast), [parsed]);
  const options = useMemo(() => collectOptions(parsed.ast), [parsed]);
  const operations = useMemo(() => collectOperations(parsed.ast), [parsed]);
  const components = useMemo(() => collectComponents(parsed.ast), [parsed]);
  const componentNames = useMemo(() => [...components.keys()].sort(), [components]);
  const stateTypes = useMemo(() => availableTypes(parsed.ast), [parsed]);
  const enumCases = useMemo(() => collectEnums(parsed.ast), [parsed]);

  // Apply a source-level state edit (splice) and re-seed, like handleApply.
  // The State panel's helpers splice a reprinted `state { … }` block; a bad
  // reprint would otherwise commit a source the builder itself can't reopen,
  // so the candidate is re-parsed by the harness before it reaches the editor.
  // `applyOrSkip`, not `applyOrRefuse`: null here means the helper found
  // nothing to edit — not a refusal.
  const applyState = harness.applyOrSkip;

  const [pageName, setPageName] = useState<string>("");
  const current = pages.find((p) => p.name === pageName) ?? pages[0];

  // Scaffold awareness (M-T8.21, audit H6).  The raw parse above never sees a
  // page a `ui … with scaffold(...)` synthesises, so the list is derived from
  // a BUILT document — async, off the render path, and only when some `ui`
  // actually carries a macro call (the cheap pre-check), so a hand-written
  // system never pays for a build.  Keyed on the parse revision; a stale
  // result (the source moved while the build ran) is dropped.
  const [scaffolded, setScaffolded] = useState<ScaffoldedPage[]>([]);
  const scaffoldSeq = useRef(0);
  useEffect(() => {
    const seq = ++scaffoldSeq.current;
    if (!harness.parseOk || !mayHaveScaffoldedPages(parsed.ast)) {
      setScaffolded([]);
      return;
    }
    void listScaffoldedPages(ctx.getSource()).then((list) => {
      if (scaffoldSeq.current === seq) setScaffolded(list);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `parsed` is the change signal; getSource reads a ref.
  }, [parsed, harness.parseOk]);

  // Eject one scaffolded page into real source, then select it.  The edits
  // are recomputed against the LIVE source at click time (the listed ones
  // were computed on the debounced parse and may be stale), and the write
  // goes through the harness so it is gated, named, and undoable.
  const unfold = async (page: ScaffoldedPage): Promise<void> => {
    const source = ctx.getSource();
    const fresh = (await listScaffoldedPages(source)).find((p) => p.key === page.key) ?? page;
    harness.on(`unfold page ${page.label}`).applyOrRefuse(unfoldScaffoldedPage(source, fresh));
    setPageName(fresh.pageName);
  };

  // "Add a page" for a system with no page at all — the model builder's `+ UI`
  // entry declares the `ui` when none exists, then a minimal page goes in.
  const addFirstPage = (): void => {
    const r = addPage(ctx.getSource());
    harness.on(NO_PAGES.addPage).applyOrRefuse(r?.source ?? null);
    if (r) setPageName(r.page);
  };

  // Local enum-type inference for assignment values: { stateFieldName → enumName }
  // for the current page's enum-typed state fields. Empty when the body is a
  // `component` (no `state {}` block) or no state field is enum-typed.
  const pageEnumFields = useMemo(
    () => (current?.page ? enumStateFields(current.page, enumCases) : new Map<string, string>()),
    [current, enumCases],
  );

  // The current page's scalar props (`route:` / `title:` / … / `menu { }`) and
  // the layout names selectable for `layout:`.  Keyed off the same `parsed`
  // revision as everything else, so one re-parse per source change — the panel
  // must not re-read on every render (see the `parsed` memo's note).
  const layouts = useMemo(() => availableLayouts(parsed.ast), [parsed]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pagePropsInfo = useMemo(() => (current?.page ? pageProps(ctx.getSource(), current.name) : null), [parsed, current]);

  // The `ui` the current page belongs to, and its DECLARATION-level structure
  // (stores / areas / menu) — the surface `page/ui-decl.ts` edits.  Read once
  // per parse revision, like `pagePropsInfo` above.
  const uiName = useMemo(
    () => (current?.page ? AstUtils.getContainerOfType(current.page, isUi)?.name : undefined),
    [current],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const uiStructure = useMemo<UiStructure | null>(() => {
    if (uiName === undefined) return null;
    const source = ctx.getSource();
    const stores = listStores(source, uiName);
    const areas = listAreas(source, uiName);
    const menu = menuInfo(source, uiName);
    const linkTargets = menuLinkTargets(source, uiName);
    return stores && areas && menu && linkTargets ? { stores, areas, menu, linkTargets } : null;
  }, [parsed, uiName]);

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
  const liveNodes = harness.liveTick > 0 ? seedNodes : initialNodes;

  if (!harness.parseOk) {
    return <Message>Source has syntax errors — fix them in the editor to use the builder.</Message>;
  }
  if (!current || !initialNodes) {
    // No editable body.  Scaffolded pages exist → list them with Unfold (the
    // customisation gradient made visible); none at all → one click to a
    // real page.  Never the old "write a `ui { page }` block" dead-end.
    return (
      <Box p="md" data-testid="c4builder-empty">
        <RefusalLine refusal={refusal} />
        {scaffolded.length > 0 ? (
          <Stack gap="xs" data-testid="c4builder-scaffolded" style={{ maxWidth: 520 }}>
            <Text size="sm" fw={600}>{SCAFFOLD.title}</Text>
            <Text size="xs" c="dimmed">{SCAFFOLD.hint}</Text>
            <ScaffoldedPagesList pages={scaffolded} onUnfold={(p) => void unfold(p)} />
          </Stack>
        ) : (
          <Stack gap="xs" data-testid="c4builder-no-pages" style={{ maxWidth: 520 }}>
            <Text size="sm" fw={600}>{NO_PAGES.title}</Text>
            <Text size="xs" c="dimmed">{NO_PAGES.hint}</Text>
            <Box>
              <Button size="xs" data-testid="c4builder-add-page" onClick={addFirstPage}>
                {NO_PAGES.addPage}
              </Button>
            </Box>
          </Stack>
        )}
      </Box>
    );
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
    harness.on(`page ${current.name} body`).applyOrRefuse(spliceNodeIfParses(source, page.expr, emitted));
  };

  return (
    // `tabIndex={-1}` + the key handler: a click anywhere on the canvas
    // focuses the pane, so ⌘Z / ⌘⇧Z route to the editor's undo stack from
    // here (text controls keep their own — see `undo-keys.ts`).
    <Box
      style={{ display: "flex", flexDirection: "column", height: "100%", outline: "none" }}
      tabIndex={-1}
      onKeyDown={paneUndoKeyHandler(ctx.editorHandleRef)}
      data-testid="c4builder-pane"
    >
      <Group px="xs" py={4} bg="dark.7" gap="xs" style={{ borderBottom: "1px solid var(--mantine-color-dark-4)" }}>
        <UndoRedo handleRef={ctx.editorHandleRef} testidPrefix="c4builder" />
        {scaffolded.length > 0 && (
          // Real pages AND scaffolded ones: the generated pages sit behind one
          // button so the gradient stays one click away without crowding the
          // page select.
          // `trapFocus` like every other Popover in the builder: without it
          // focus stays on the trigger, Mantine's Escape handler (bound on the
          // DROPDOWN) never sees the key, and the portal is left open over the
          // canvas swallowing clicks — keyboard users had no way to dismiss it.
          <Popover position="bottom-start" withArrow shadow="md" trapFocus>
            <Popover.Target>
              <Button size="compact-xs" variant="default" data-testid="c4builder-scaffold-list">
                {SCAFFOLD.listButton} ({scaffolded.length})
              </Button>
            </Popover.Target>
            <Popover.Dropdown p="xs" style={{ width: 360 }}>
              <Text size="xs" c="dimmed" mb={6}>{SCAFFOLD.hint}</Text>
              <ScaffoldedPagesList pages={scaffolded} onUnfold={(p) => void unfold(p)} />
            </Popover.Dropdown>
          </Popover>
        )}
        {ctx.isDesktop && current.page && (
          <>
            <StatePanel page={current.page} getSource={() => ctx.getSource()} types={stateTypes} enumCases={enumCases} onApply={applyState} />
            {pagePropsInfo && (
              <PagePropsPanel
                pageName={current.name}
                info={pagePropsInfo}
                layouts={layouts}
                getSource={() => ctx.getSource()}
                onApply={applyState}
              />
            )}
            {uiName !== undefined && uiStructure && (
              <UiStructurePanel
                uiName={uiName}
                structure={uiStructure}
                getSource={() => ctx.getSource()}
                onApply={applyState}
              />
            )}
          </>
        )}
      </Group>
      <RefusalLine refusal={refusal} />
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

// --- page settings panel ---------------------------------------------------
//
// A "Page settings" popover next to the State popover in the page-builder
// chrome: the page's scalar props (`route:` / `title:` / `requires` /
// `layout:` / `description:` / `ogImage:` / `canonical:`) plus its
// `menu { … }` metadata.  Every edit is a narrow CST splice through
// `page/page-props.ts`; a refused mutation returns null and `applyState`
// leaves the source untouched, matching the existing handlers.  Desktop-only
// (it lives inside the `ctx.isDesktop` chrome), so the compact/mobile
// rendering is unchanged.

/** Render a plain string as `.ddd` STRING-literal source. */
const quoteText = (v: string): string => JSON.stringify(v);

/** Inverse of `quoteText` for display: unwrap a string literal, pass anything
 *  else (a computed `title:` expression, a numeric menu `order`) through. */
function unquoteText(raw: string | undefined): string {
  if (!raw) return "";
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

function PagePropsPanel({ pageName, info, layouts, getSource, onApply }: {
  pageName: string;
  info: PagePropsInfo;
  layouts: string[];
  getSource: () => string;
  onApply: (next: string | null) => void;
}): JSX.Element {
  // Each setter is `(source, pageName, value | null) → string | null`.
  const commit = (
    set: (source: string, page: string, value: string | null) => string | null,
  ) => (value: string | null): void => onApply(set(getSource(), pageName, value));
  const menu = (key: "section" | "label" | "order" | "hidden") => (value: string | null): void =>
    onApply(setPageMenuMeta(getSource(), pageName, key, value));
  return (
    <Popover position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button size="compact-xs" variant="default" data-testid="c4props-toggle">Page settings</Button>
      </Popover.Target>
      <Popover.Dropdown p="xs" style={{ width: 420 }}>
        <Text size="xs" tt="uppercase" c="dimmed" mb={6}>Page {pageName}</Text>
        <PropRow key={`route:${info.route ?? ""}`} label="route" value={info.route ?? ""} placeholder="/orders" testid="c4props-route" onCommit={commit(setPageRoute)} />
        {/* `title:` is an Expression in the grammar — the raw source text is
            edited so `"Orders for " + customer.name` stays editable. */}
        <PropRow key={`title:${info.title ?? ""}`} label="title" value={info.title ?? ""} placeholder={'"Orders"'} testid="c4props-title" onCommit={commit(setPageTitle)} />
        <PropRow key={`requires:${info.requiresText ?? ""}`} label="requires" value={info.requiresText ?? ""} placeholder="currentUser.permissions.contains(p)" testid="c4props-requires" onCommit={commit(setPageRequires)} />
        <Group gap={6} mb={4} wrap="nowrap">
          <Text size="xs" style={{ width: 78, fontFamily: "monospace" }} truncate>layout</Text>
          <Select
            size="xs"
            style={{ flex: 1 }}
            clearable
            searchable
            placeholder="default"
            data={[...new Set([...layouts, info.layout].filter((v): v is string => !!v))]}
            value={info.layout ?? null}
            data-testid="c4props-layout"
            onChange={(v) => commit(setPageLayout)(v)}
          />
        </Group>
        <PropRow key={`description:${info.description ?? ""}`} label="description" value={info.description ?? ""} placeholder="page summary" testid="c4props-description" onCommit={commit(setPageDescription)} />
        <PropRow key={`ogImage:${info.ogImage ?? ""}`} label="ogImage" value={info.ogImage ?? ""} placeholder="/og.png" testid="c4props-ogimage" onCommit={commit(setPageOgImage)} />
        <PropRow key={`canonical:${info.canonical ?? ""}`} label="canonical" value={info.canonical ?? ""} placeholder="https://…" testid="c4props-canonical" onCommit={commit(setPageCanonical)} />
        <Divider my={6} />
        <Text size="xs" tt="uppercase" c="dimmed" mb={6}>Sidebar menu</Text>
        <PropRow key={`section:${info.menu.section ?? ""}`} label="section" value={unquoteText(info.menu.section)} placeholder="Sales" testid="c4props-menu-section" onCommit={(v) => menu("section")(v === null ? null : quoteText(v))} />
        <PropRow key={`label:${info.menu.label ?? ""}`} label="label" value={unquoteText(info.menu.label)} placeholder="All orders" testid="c4props-menu-label" onCommit={(v) => menu("label")(v === null ? null : quoteText(v))} />
        {/* `order` is a numeric expression — written through verbatim. */}
        <PropRow key={`order:${info.menu.order ?? ""}`} label="order" value={info.menu.order ?? ""} placeholder="0" testid="c4props-menu-order" onCommit={menu("order")} />
        <Checkbox
          size="xs"
          mt={4}
          label="hidden"
          checked={info.menu.hidden === "true"}
          data-testid="c4props-menu-hidden"
          onChange={(e) => menu("hidden")(e.currentTarget.checked ? "true" : null)}
        />
      </Popover.Dropdown>
    </Popover>
  );
}

// --- ui structure panel ----------------------------------------------------
//
// A "UI structure" popover beside "Page settings": the `ui { … }` members that
// sit AROUND the pages — `store`s (with their `persist:` mode and state-field
// count), the `area { }` tree (with a move-a-page-here select), and the
// ui-level `menu { section … }` sidebar.  An INSPECTOR, not a designer: every
// control is one call into `page/ui-decl.ts`, whose refused edits return null
// and leave the source untouched via `applyState`.  Desktop-only, like its
// sibling (it renders inside the `ctx.isDesktop` chrome).

interface UiStructure {
  stores: StoreInfo[];
  areas: AreaTree;
  menu: MenuInfo;
  /** Names a `menu { link … }` can resolve — bare and area-qualified. */
  linkTargets: string[];
}

/** Depth-first flattening of the area tree, so the panel can render it as an
 *  indented list (each row keyed + indented by its own path). */
function flattenAreas(areas: readonly AreaInfo[]): AreaInfo[] {
  return areas.flatMap((a) => [a, ...flattenAreas(a.areas)]);
}

function UiStructurePanel({ uiName, structure, getSource, onApply }: {
  uiName: string;
  structure: UiStructure;
  getSource: () => string;
  onApply: (next: string | null) => void;
}): JSX.Element {
  const { stores, areas, menu, linkTargets } = structure;
  const [areaName, setAreaName] = useState("");
  const [areaParent, setAreaParent] = useState<string | null>(null);
  const [sectionLabel, setSectionLabel] = useState("");
  const flatAreas = flattenAreas(areas.areas);
  const allPages = [...areas.rootPages, ...flatAreas.flatMap((a) => a.pages)];

  // One "move a page into this container" select; picking a page applies the
  // move and the select resets (its value is always null).
  const moveInto = (area: string | null) => (page: string | null): void => {
    if (page) onApply(movePageToArea(getSource(), uiName, page, area));
  };

  return (
    <Popover position="bottom-start" withArrow shadow="md" trapFocus>
      <Popover.Target>
        <Button size="compact-xs" variant="default" data-testid="uidecl-toggle">UI structure</Button>
      </Popover.Target>
      <Popover.Dropdown p="xs" style={{ width: 460, maxHeight: "70vh", overflowY: "auto" }}>
        <Text size="xs" tt="uppercase" c="dimmed" mb={6}>ui {uiName}</Text>

        <Text size="xs" fw={600} mb={4}>Stores</Text>
        {stores.length === 0 && <Text size="xs" c="dimmed" mb={4}>none</Text>}
        {stores.map((s) => (
          <Group key={s.name} gap={6} mb={4} wrap="nowrap">
            <Text size="xs" style={{ width: 96, fontFamily: "monospace" }} truncate>{s.name}</Text>
            <Select
              size="xs"
              style={{ width: 104 }}
              clearable
              placeholder="memory"
              data={[...STORE_PERSIST_MODES]}
              value={s.persist ?? null}
              data-testid={`uidecl-persist-${s.name}`}
              onChange={(v) => onApply(setStorePersist(getSource(), uiName, s.name, v as StorePersist | null))}
            />
            <Text size="xs" c="dimmed" style={{ width: 56 }}>{s.fieldCount}f · {s.actionCount}a</Text>
            <Button
              size="compact-xs"
              variant="subtle"
              data-testid={`uidecl-store-addfield-${s.name}`}
              onClick={() => onApply(addStoreField(getSource(), uiName, s.name))}
            >
              + field
            </Button>
            <DeleteButton
              spec={confirmSites.uiMemberDelete("store", s.name)}
              testid={`uidecl-store-delete-${s.name}`}
              onConfirm={() => onApply(deleteStore(getSource(), uiName, s.name))}
            />
          </Group>
        ))}
        <Button
          size="compact-xs"
          variant="default"
          data-testid="uidecl-store-add"
          onClick={() => onApply(addStore(getSource(), uiName))}
        >
          Add store
        </Button>

        <Divider my={6} />
        <Text size="xs" fw={600} mb={4}>Areas</Text>
        <AreaRow label="(root)" depth={0} pages={areas.rootPages} pageOptions={allPages} testid="uidecl-area-root" onMove={moveInto(null)} />
        {flatAreas.map((a) => (
          <AreaRow
            key={a.path.join(".")}
            label={a.name}
            depth={a.path.length}
            pages={a.pages}
            pageOptions={allPages}
            testid={`uidecl-area-${a.path.join("-")}`}
            onMove={moveInto(a.name)}
          />
        ))}
        <Group gap={6} mb={4} wrap="nowrap">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            placeholder="new area"
            value={areaName}
            data-testid="uidecl-area-name"
            onChange={(e) => setAreaName(e.currentTarget.value)}
          />
          <Select
            size="xs"
            style={{ width: 120 }}
            clearable
            searchable
            placeholder="at root"
            data={flatAreas.map((a) => a.name)}
            value={areaParent}
            data-testid="uidecl-area-parent"
            onChange={setAreaParent}
          />
          <Button
            size="compact-xs"
            variant="default"
            data-testid="uidecl-area-add"
            onClick={() => {
              onApply(addArea(getSource(), uiName, areaName, areaParent ?? undefined));
              setAreaName("");
            }}
          >
            Add
          </Button>
        </Group>

        <Divider my={6} />
        <Text size="xs" fw={600} mb={4}>Sidebar menu</Text>
        {!menu.hasMenu && <Text size="xs" c="dimmed" mb={4}>derived from per-page menu metadata</Text>}
        {menu.sections.map((s) => (
          <Box key={s.label} mb={4}>
            <Group gap={6} wrap="nowrap">
              <Text size="xs" fw={500} style={{ flex: 1 }} truncate>{s.label}</Text>
              <Select
                size="xs"
                style={{ width: 150 }}
                searchable
                placeholder="+ link page"
                data={linkTargets}
                value={null}
                data-testid={`uidecl-menu-addlink-${s.label}`}
                onChange={(v) => v && onApply(addMenuLink(getSource(), uiName, s.label, { page: v }))}
              />
              <DeleteButton
                spec={confirmSites.uiMemberDelete("menu section", s.label)}
                testid={`uidecl-menu-delsection-${s.label}`}
                onConfirm={() => onApply(deleteMenuSection(getSource(), uiName, s.label))}
              />
            </Group>
            {s.entries.map((e, i) => (
              <Group key={`${s.label}:${i}:${e.kind === "page" ? e.page : e.url}`} gap={6} pl={14} wrap="nowrap">
                <Text size="xs" c="dimmed" style={{ flex: 1, fontFamily: "monospace" }} truncate>
                  {e.kind === "page" ? e.page : `${e.label} → ${e.url}`}
                </Text>
                <DeleteButton
                  spec={confirmSites.uiMemberDelete("menu link", e.kind === "page" ? e.page : e.label)}
                  testid={`uidecl-menu-dellink-${s.label}-${i}`}
                  onConfirm={() => onApply(deleteMenuLink(getSource(), uiName, s.label, i))}
                />
              </Group>
            ))}
          </Box>
        ))}
        <Group gap={6} wrap="nowrap">
          <TextInput
            size="xs"
            style={{ flex: 1 }}
            placeholder="new section"
            value={sectionLabel}
            data-testid="uidecl-menu-section"
            onChange={(e) => setSectionLabel(e.currentTarget.value)}
          />
          <Button
            size="compact-xs"
            variant="default"
            data-testid="uidecl-menu-addsection"
            onClick={() => {
              onApply(addMenuSection(getSource(), uiName, sectionLabel));
              setSectionLabel("");
            }}
          >
            Add
          </Button>
        </Group>
      </Popover.Dropdown>
    </Popover>
  );
}

// A red `×` that arms the shared inline confirm in place (M-T8.17): the row's
// splice only runs from the confirm's Yes.  `testid` stays on the trigger so
// the existing selectors still find it; the row derives `${testid}-yes` /
// `${testid}-cancel`.
function DeleteButton({ spec, testid, onConfirm }: { spec: ConfirmSpec; testid: string; onConfirm: () => void }): JSX.Element {
  return (
    <ConfirmAction
      spec={spec}
      onConfirm={onConfirm}
      testids={{ base: testid }}
      size="compact-xs"
      trigger={(arm) => (
        <Button size="compact-xs" variant="subtle" color="red" data-testid={testid} aria-label={spec.consequence} title={spec.consequence} onClick={arm}>
          <IconX />
        </Button>
      )}
    />
  );
}

// One area row: its pages, plus the select that moves another page into it.
function AreaRow({ label, depth, pages, pageOptions, testid, onMove }: {
  label: string;
  depth: number;
  pages: string[];
  pageOptions: string[];
  testid: string;
  onMove: (page: string | null) => void;
}): JSX.Element {
  return (
    <Group gap={6} mb={4} wrap="nowrap" pl={depth * 10}>
      <Text size="xs" style={{ width: 96, fontFamily: "monospace" }} truncate>{label}</Text>
      <Text size="xs" c="dimmed" style={{ flex: 1 }} truncate>{pages.join(", ") || "—"}</Text>
      <Select
        size="xs"
        style={{ width: 150 }}
        searchable
        placeholder="move page here"
        data={pageOptions}
        value={null}
        data-testid={testid}
        onChange={onMove}
      />
    </Group>
  );
}

// One labelled text input.  Local state while typing, committed on blur (or
// Enter) — the same pattern the State panel's default-value input uses.  An
// emptied input commits `null`, which REMOVES the prop.  The row is keyed on
// its incoming value by the caller, so it re-seeds after its own edit lands.
function PropRow({ label, value, placeholder, testid, onCommit }: {
  label: string;
  value: string;
  placeholder?: string;
  testid: string;
  onCommit: (value: string | null) => void;
}): JSX.Element {
  const [text, setText] = useState(value);
  const flush = (): void => {
    if (text === value) return;
    onCommit(text.trim() === "" ? null : text);
  };
  return (
    <Group gap={6} mb={4} wrap="nowrap">
      <Text size="xs" style={{ width: 78, fontFamily: "monospace" }} truncate>{label}</Text>
      <TextInput
        size="xs"
        style={{ flex: 1 }}
        placeholder={placeholder}
        value={text}
        data-testid={testid}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={flush}
        onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
      />
    </Group>
  );
}

// The scaffolded-page rows: `Orders / List` + the *scaffolded* badge + Unfold.
// Read-only by construction — a page with no source range has nothing the
// canvas could edit; Unfold is the one action.  Row ids use the key with the
// `/` replaced (`c4builder-scaffold-row-Orders-List`) so a spec can address
// one page.
function ScaffoldedPagesList({ pages, onUnfold }: {
  pages: readonly ScaffoldedPage[];
  onUnfold: (page: ScaffoldedPage) => void;
}): JSX.Element {
  return (
    <Stack gap={2}>
      {pages.map((p) => {
        const id = p.key.replace(/\//g, "-");
        return (
          <Group key={p.key} gap={6} wrap="nowrap" data-testid={`c4builder-scaffold-row-${id}`}>
            <Text size="xs" style={{ flex: 1, minWidth: 0, fontFamily: "monospace" }} truncate title={`${p.uiName} · with ${p.macroName}`}>
              {p.label}
            </Text>
            <Badge size="xs" variant="light" color="gray" style={{ flexShrink: 0 }} title={`Synthesised by with ${p.macroName} on ui ${p.uiName}`}>
              {SCAFFOLD.badge}
            </Badge>
            <Button
              size="compact-xs"
              variant="light"
              data-testid={`c4builder-unfold-${id}`}
              aria-label={`${SCAFFOLD.unfold} page ${p.label}`}
              onClick={() => onUnfold(p)}
            >
              {SCAFFOLD.unfold}
            </Button>
          </Group>
        );
      })}
    </Stack>
  );
}

function Message({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <Box p="md">
      <Text size="sm" c="dimmed">{children}</Text>
    </Box>
  );
}
