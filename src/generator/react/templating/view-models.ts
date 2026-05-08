// ---------------------------------------------------------------------------
// View-model types for the template-pack rendering layer.
//
// View-models are framework-neutral: they carry every *decision* the
// generator has made (humanized labels, formatter choice per type,
// link targets, op-icon picks, etc.) but no UI-library-specific text.
// Mantine, shadcn, and custom packs all render against the same VMs.
//
// VMs lean on string-typed JS expression slots (`valueExpr`,
// `keyExpr`) where the template needs to splice raw JS — for instance
// `row.customerId` or `data.id.slice(0, 8)`.  Templates are responsible
// for placing these inside `{}`/`{{{ }}}` JSX braces; preparers are
// responsible for ensuring the expressions evaluate correctly in the
// surrounding scope (e.g. `row` for table rows, `data` for detail).
// ---------------------------------------------------------------------------

/** A single cell in a list-page table row. */
export interface CellVM {
  /** Logical template name to render for this cell.  The pack's
   *  pack.json `emits` map resolves it to a .hbs file.  Examples:
   *  "cell-id-link", "cell-datetime", "cell-bool", "cell-number",
   *  "cell-enum", "cell-string", "cell-empty". */
  template: string;
  /** Stable testid for Playwright drivers — pack-invariant, computed
   *  by the preparer from slug + row id + field name.  Templates emit
   *  it verbatim on `<Table.Td data-testid={...}>`. */
  testIdExpr: string;
  /** JS expression that evaluates to the cell's raw value in the
   *  template's surrounding scope (typically `row.<field>`).  Templates
   *  splice this into JSX braces; semantics depend on `template`. */
  valueExpr: string;
  /** When the cell is a link, the React-Router target as a JS
   *  template-string expression — e.g. "`/customers/${row.id}`".
   *  Templates wrap the cell content in an Anchor pointing here.
   *  Undefined for non-link cells. */
  toExpr?: string;
  /** Decimal precision for number cells.  0 for int/long, 2 for
   *  decimal.  Undefined for other cell kinds. */
  decimals?: number;
}

/** A breadcrumb segment.  `to` is undefined for the current-page
 *  segment (rendered as plain text); otherwise rendered as an
 *  Anchor link. */
export interface BreadcrumbSegmentVM {
  label: string;
  to?: string;
}

/** Theme view-model — semantic design tokens, framework-neutral.
 *  Each pack's `theme` template projects these tokens to its idiom:
 *  Mantine emits a `createTheme(...)` config with the shade arrays
 *  baked in; shadcn (Phase 2) will emit CSS variables on :root.
 *  Defaults are applied by the preparer so every generated app
 *  gets a coherent baseline even when the DSL declares no
 *  `theme { ... }` block. */
export interface ThemeVM {
  /** 10-shade brand colour ramp.  Index 6 anchors the user's input
   *  hex; the rest are interpolated against white (lighter half) and
   *  black (darker half) using HSL lightness. */
  brandShades: string[];
  /** 10-shade neutral / surface colour ramp, same indexing scheme. */
  neutralShades: string[];
  /** Default border radius for primitives — "xs" / "sm" / "md" /
   *  "lg" / "xl".  Mantine reads it directly; shadcn maps to
   *  `--radius` CSS variable. */
  radius: string;
  /** Body / heading font-family value, verbatim — exactly as the
   *  template should embed it inside the JSON-stringified config.
   *  Includes the full fallback chain. */
  fontFamily: string;
  /** Monospace font-family for code / id displays. */
  fontFamilyMonospace: string;
}

/** A single import statement to emit at the top of a generated
 *  module.  `specifier` is the imported symbol exactly as written
 *  on the import line — for default imports this is just the local
 *  name (`OrderList`); for named imports it can include braces. */
export interface ImportVM {
  /** Name binding as it appears between `import` and `from`, e.g.
   *  "OrderList" or "{ Routes, Route }". */
  specifier: string;
  /** Module path including any `.tsx` / `.ts` discriminator the
   *  target tsconfig requires.  React frontend uses Bundler
   *  resolution so extension-less is correct. */
  from: string;
}

/** A single React Router route the App.tsx Routes block emits. */
export interface RouteVM {
  /** URL pattern, e.g. "/orders/:id". */
  path: string;
  /** JSX expression for the `element` prop, verbatim — e.g.
   *  "<OrderDetail />". */
  elementJsx: string;
}

/** A single sidebar nav entry. */
export interface NavEntryVM {
  /** React-Router target path. */
  to: string;
  /** Visible link text. */
  label: string;
  /** Stable testid for Playwright drivers. */
  testId: string;
  /** Argument list (verbatim) to splice into `isActive(...)` —
   *  e.g. `"/orders"` or `"/workflows", { exact: true }`.  The
   *  exact form is used for index pages whose slug prefix would
   *  otherwise match every per-item child route. */
  activeArgs: string;
}

/** A grouped sidebar section.  Renders as a Divider with the
 *  section label followed by `entries`.  Sections with zero
 *  entries are omitted from the VM (preparer skips them) so
 *  templates don't need empty-guards. */
export interface NavSectionVM {
  label: string;
  entries: NavEntryVM[];
}

/** Top-level view-model for the App.tsx shell. */
export interface AppShellVM {
  /** Humanised system name for the header brand mark. */
  systemNameHuman: string;
  /** Page-component imports the routes refer to. */
  imports: ImportVM[];
  /** Every route the Router renders, in source order. */
  routes: RouteVM[];
  /** One section per construct kind that has at least one entry. */
  navSections: NavSectionVM[];
}

/** Trivial VM for main.tsx — no decisions, but routed through the
 *  pack so a future shadcn pack can swap the provider chain
 *  (MantineProvider + ModalsProvider → shadcn's Toaster + Sonner). */
export interface MainVM {
  // No fields today; reserved for shape stability.
}

/** Top-level view-model for the home page (landing). */
export interface HomeVM {
  /** Humanised system name for the eyebrow label. */
  systemNameHuman: string;
  aggregateCount: number;
  workflowCount: number;
  viewCount: number;
  /** Slug of the first aggregate, used as the target of the "Browse
   *  the sidebar →" link.  Undefined when the deployable has no
   *  aggregates (in practice empty deployables don't generate
   *  React projects, but the field is optional for safety). */
  firstAggregateSlug?: string;
}

/** Top-level view-model for an aggregate list page. */
export interface ListPageVM {
  /** PascalCase aggregate name — drives the React component export
   *  name (e.g. "Customer" → `function CustomerList()`). */
  aggregateName: string;
  /** Snake-case plural slug — drives URL paths and testid prefixes
   *  ("customers" → "/customers", "customers-list-create"). */
  slug: string;
  /** Plural humanised label for the page title and breadcrumb tail
   *  ("Customers", "Order Lines"). */
  humanPlural: string;
  /** Plural humanised lowercase label for empty-state / alert copy
   *  ("customers", "order lines"). */
  humanPluralLower: string;
  /** Singular humanised lowercase label for the "+ New <thing>"
   *  button copy ("customer", "order line"). */
  humanSingularLower: string;
  /** Breadcrumb trail for the list page — typically a 2-segment
   *  "Home / <Plural>" trail. */
  breadcrumbs: BreadcrumbSegmentVM[];
  /** Column header labels in row order, including the leading "Id"
   *  column. */
  columnHeaders: string[];
  /** One CellVM per column.  Index aligns with columnHeaders.  The
   *  first entry is always the id link cell. */
  cells: CellVM[];
  /** Name of the React Query hook that fetches the list, e.g.
   *  "useAllCustomers".  Imported from `../../api/<camel>.ts`. */
  hookName: string;
  /** camelCase aggregate name for the api-module import path
   *  (`../../api/<camel>` → `../../api/customer`). */
  hookImportPath: string;
}
