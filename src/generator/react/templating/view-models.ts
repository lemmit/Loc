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

/** A single form input.  Picked per field type by the preparer:
 *  string → field-input-string, int/long → field-input-int, etc.
 *  Value-objects compose recursively: the preparer returns the
 *  Fieldset VM with `children: FormFieldVM[]`, the renderer walks
 *  them in TS, pre-renders each child, then joins the HTML into
 *  `innerHtml` before rendering the parent template.
 *
 *  Fields whose template doesn't need a particular optional
 *  field leave it undefined; templates index-only into the keys
 *  they care about. */
export interface FormFieldVM {
  /** Logical template name. */
  template: string;
  /** RHF dotted path (e.g. "customerId", "price.amount"). */
  path: string;
  /** Humanised label, derived from the leaf path segment so nested
   *  value-object fields render as "Amount" not "price.amount". */
  label: string;
  /** Stable testid for Playwright drivers. */
  testId: string;
  /** RHF errors expression — `errors.customerId?.message` or
   *  `errors.price?.amount?.message` (dotted path → optional-chained
   *  access).  Templates splice via `error={{expr errorExpr}}`. */
  errorExpr: string;
  /** Local variable name for `useAllX().data` in id-select fields. */
  hookVar?: string;
  /** Target aggregate's display field name (becomes the option label). */
  displayField?: string;
  /** Pre-quoted JSON literal for the `placeholder` attribute on the
   *  fallback id-text field (when target / display is missing). */
  placeholderJson?: string;
  /** Pre-quoted JSON array literal for the enum-select `data` prop. */
  enumValuesJson?: string;
  /** Recursive children for value-object Fieldsets.  Renderer walks
   *  these, pre-renders each, joins into `innerHtml`. */
  children?: FormFieldVM[];
}

/** Top-level VM for an aggregate's `new` page. */
export interface NewPageVM {
  aggregateName: string;
  aggregateNameCamel: string;
  slug: string;
  humanAgg: string;
  humanAggLower: string;
  humanPlural: string;
  /** Symbol names for the `@mantine/core` import line.  The Mantine
   *  template splices via `{{join mantineImports ", "}}`; shadcn
   *  pack ignores it (its own template has fixed imports). */
  mantineImports: string[];
  /** Pre-formatted import lines for cross-aggregate `useAllX()`
   *  hooks the form's id-selects reference. */
  idHookImportLines: string[];
  /** Pre-formatted const declarations calling those hooks inside
   *  the page function body. */
  idHookCalls: string[];
  /** "useForm" or "useForm, Controller" for the RHF import. */
  useFormImports: string;
  /** Destructured argument list for the useForm() return — either
   *  with `control` (when any field needs Controller) or without. */
  destructuredHookFields: string;
  /** initialValuesTs() result — TS object literal for RHF defaults. */
  defaultValuesTs: string;
  /** One FormFieldVM per non-optional source field (preparer filters
   *  optional fields out of the create form, matching legacy
   *  buildNewPage behaviour).  Renderer pre-renders each into HTML
   *  and slots them via {{{this}}} loops. */
  fields: FormFieldVM[];
}

/** Top-level VM for one operation's modal-form pair (the
 *  `function openXModal` + `function XForm` block emitted at
 *  module scope after a detail page's default export).  Phase 1.4
 *  ports this so the modal forms render through pack templates,
 *  reusing the same field-input-* set as page-new. */
export interface OperationModalVM {
  aggregateName: string;
  slug: string;
  /** Raw camelCase op name. */
  opName: string;
  /** PascalCase variant for type / function identifiers. */
  opPascal: string;
  /** Humanised label for modal title + submit-button text. */
  humanOp: string;
  /** Whether this op has any parameters.  When false, the template
   *  emits a "This operation has no parameters." placeholder. */
  hasParams: boolean;
  /** Pre-formatted const declarations for `useAllX()` hooks any
   *  Id<X> param's select references. */
  idHookCalls: string[];
  /** Destructured argument list for useForm(). */
  destructured: string;
  /** initialValuesTs() result for the op's params. */
  defaultValuesTs: string;
  /** One FormFieldVM per param. */
  fields: FormFieldVM[];
}

/** Top-level VM for a per-workflow form page. */
export interface WorkflowFormVM {
  /** PascalCase workflow name (drives `<Wf>Request` / `use<Wf>Workflow`). */
  workflowPascal: string;
  /** PascalCase workflow page-component name. */
  componentName: string;
  /** Snake-case slug (URL + testid). */
  slug: string;
  /** Humanised workflow label for the title / breadcrumbs / toast. */
  humanWorkflow: string;
  mantineImports: string[];
  idHookImportLines: string[];
  idHookCalls: string[];
  useFormImports: string;
  destructured: string;
  defaultValuesTs: string;
  /** Whether the workflow has any parameters; when false the
   *  template emits a "This workflow has no parameters." line. */
  hasParams: boolean;
  fields: FormFieldVM[];
}

/** A single workflow parameter for the workflows index card. */
export interface WorkflowCardParamVM {
  /** Raw param name (camelCase) — used in testids. */
  name: string;
  /** Humanised label ("Customer Id"). */
  humanName: string;
  /** JSON-quoted type-label string ready to splice as a JS string
   *  literal — e.g. `"string"` or `"Id<Product>"`.  Quoted so JSX
   *  doesn't try to parse `<Product>` as an opening tag. */
  typeLabelJson: string;
}

/** A single workflow listed on the workflows index page. */
export interface WorkflowCardVM {
  slug: string;
  humanWorkflow: string;
  /** Structured per-param data.  Each pack's template iterates and
   *  renders in its own idiom. */
  params: WorkflowCardParamVM[];
  /** True when the workflow declares zero parameters — the
   *  template emits a "No parameters." note instead. */
  hasParams: boolean;
}

/** Workflows index page (the /workflows route). */
export interface WorkflowsIndexVM {
  cards: WorkflowCardVM[];
}

/** A single view listed on the views index page. */
export interface ViewCardVM {
  slug: string;
  humanView: string;
  /** Pre-formatted shape line — either "Source: <Aggregate>" for
   *  shorthand views or "Custom shape: <field names>" for full-form. */
  shapeLine: string;
}

/** Views index page (the /views route). */
export interface ViewsIndexVM {
  cards: ViewCardVM[];
}

/** Per-view table page.  Cells reuse the page-list cell-* templates
 *  via TS-side composition (renderer pre-renders each, slots into
 *  cellHtml).  Same architectural pattern as PartTableVM. */
export interface ViewTablePageVM {
  componentName: string;
  hookName: string;
  slug: string;
  humanView: string;
  columnHeaders: string[];
  cells: CellVM[];
}

/** A single field-row inside a detail page's main info card.  Each
 *  row picks a `field-row-*` template per-pack (e.g. `field-row-id`,
 *  `field-row-datetime`, `field-row-valueobject`) and is rendered
 *  in TS by the preparer, then injected into the page VM as
 *  `rowHtml`.  Same TS-side composition pattern as cells. */
export interface FieldRowVM {
  /** Logical template name to render for this row. */
  template: string;
  /** Humanised label that appears in the left column of the
   *  KeyValueRow (or pack equivalent). */
  label: string;
  /** Stable per-field testid for Playwright drivers — pack-invariant
   *  by construction so e2e tests survive pack swaps. */
  testId: string;
  /** JS expression evaluating to the field's raw value in the
   *  surrounding scope (typically `data.<field>`). */
  valueExpr: string;
  /** Link target (template-string expression) for `field-row-id-link`
   *  rows; undefined for non-link rows. */
  toExpr?: string;
  /** Decimal precision for number rows. */
  decimals?: number;
  /** For value-object field-row rendering: per-VO-field display
   *  data ({ humanLabel, testId, valueExpr }) the template
   *  iterates and renders in its pack's idiom (Mantine <Text> /
   *  shadcn Tailwind div).  Replaces the older `innerHtml` slot
   *  which baked Mantine JSX into the preparer. */
  voFields?: { humanLabel: string; testId: string; valueExpr: string }[];
}

/** A nested-collection part-table inside a detail page.  E.g.
 *  Order.lines (`contains lines: OrderLine[]`) emits one PartTableVM.
 *  Cells are reused from the page-list cell templates — same wire
 *  shape, same testid pattern, just a different access expression
 *  (`row.foo` is rooted in the part-row, while the page itself
 *  iterates `data.<name>.map((row) => ...)`). */
export interface PartTableVM {
  /** Display name / containment slot ("lines"). */
  name: string;
  /** Humanised section title ("Lines", "Order Items"). */
  humanName: string;
  /** Pre-rendered column header labels. */
  columnHeaders: string[];
  /** One CellVM per column, with testIdExpr keyed off the part's
   *  scoping (`<slug>-detail-<name>-row-${row.id}-<col>`). */
  cells: CellVM[];
  /** Stable testid for the wrapping element. */
  testId: string;
  /** JS expression for the array on `data` to map over (e.g.
   *  `data.lines`). */
  arrayExpr: string;
}

/** A single operation button rendered in the detail page header
 *  group.  The first op gets variant=filled (primary), subsequent
 *  ops get variant=light, so the most-likely "next step" pops
 *  visually. */
export interface OperationButtonVM {
  /** Raw camelCase op name (e.g. "addLine") — used for testid + JS
   *  identifier construction. */
  name: string;
  /** Humanised button label ("Add Line"). */
  humanName: string;
  /** "filled" for the leading op, "light" for the rest. */
  variant: string;
  /** Tabler icon component name (e.g. "IconPlus") or undefined. */
  icon?: string;
  /** Stable testid. */
  testId: string;
}

/** Top-level view-model for the detail page. */
export interface DetailPageVM {
  /** PascalCase aggregate name — drives the React component export
   *  name (`OrderDetail`). */
  aggregateName: string;
  /** camelCase aggregate name (`order`) for JS identifiers. */
  aggregateNameCamel: string;
  /** Snake-case plural slug ("orders") — drives testid prefixes
   *  and link targets. */
  slug: string;
  /** Singular humanised label ("Order") for the type-eyebrow. */
  humanAgg: string;
  /** Lowercase singular ("order") for alert / not-found copy. */
  humanAggLower: string;
  /** Plural humanised ("Orders") for the breadcrumb. */
  humanPlural: string;
  /** JS expression for the page title — either `data.<displayField>`
   *  when the aggregate declares one, or a short id slice. */
  titleExpr: string;
  /** Field rows in source order. */
  fieldRows: FieldRowVM[];
  /** Nested part-tables in source order. */
  parts: PartTableVM[];
  /** Operation buttons (empty when the aggregate has no public ops). */
  opButtons: OperationButtonVM[];
  /** Imports lines for `useXById`, `useOpY`, request-type symbols,
   *  and any cross-aggregate `useAll<X>()` hooks the operation
   *  modals reference.  Pre-formatted as full `import ... from "...";`
   *  strings so the template just splices them in. */
  apiImportLines: string[];
  /** Tabler icon names to import — at minimum IconAlertCircle and
   *  IconAlertTriangle for the error / not-found alerts; plus one
   *  per operation button that has a verb-mapped icon. */
  tablerIcons: string[];
  /** Whether any operation form needs RHF's Controller (for
   *  Select / Switch / NumberInput) or just register (TextInput). */
  needsController: boolean;
  /** Per-op modal-form function blocks, pre-rendered as TSX strings
   *  by the renderer (which calls renderOperationModal once per op).
   *  Templates emit them verbatim at module scope after the default
   *  export. */
  operationsModalsTsx: string[];
  /** Per-op `useXOrder(id ?? "")` mutation-hook lines, formatted as
   *  TS const declarations.  Templates emit them inside the page
   *  function body. */
  opHookCallLines: string[];
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
