// ---------------------------------------------------------------------------
// View-model types for the template-pack rendering layer.
//
// View-models are framework-neutral: they carry every *decision* the
// generator has made (humanized labels, formatter choice per type,
// link targets) but no UI-library-specific text.  Every pack
// (Mantine, shadcn, MUI, chakra, coreComponents) renders against the same VMs.
//
// VMs lean on string-typed JS expression slots (`valueExpr`,
// `errorExpr`) where the template needs to splice raw JS.  Templates
// are responsible for placing these inside `{}`/`{{{ }}}` JSX braces;
// preparers are responsible for ensuring the expressions evaluate
// correctly in the surrounding scope.
//
// Scope: only the VMs consumed by the live preparers + walker survive.
// The archetype-era VMs (ListPageVM / DetailPageVM / NewPageVM /
// WorkflowFormVM / ViewTablePageVM / HomeVM / OperationModalVM /
// ColumnVM / FieldRowVM / BreadcrumbSegmentVM / MainVM) were deleted
// alongside their preparers + templates when the walker became the
// single codegen path.
// ---------------------------------------------------------------------------

/** Theme view-model — semantic design tokens, framework-neutral.
 *  Each pack's `theme` template projects these tokens to its idiom:
 *  Mantine emits a `createTheme(...)` config with the shade arrays
 *  baked in; shadcn emits CSS variables on :root; MUI / chakra use
 *  their own theming APIs.  Defaults are applied by the preparer so
 *  every generated app gets a coherent baseline even when the DSL
 *  declares no `theme { ... }` block. */
export interface ThemeVM {
  /** 10-shade brand colour ramp.  Index 6 anchors the user's input
   *  hex; the rest are interpolated against white (lighter half) and
   *  black (darker half) using HSL lightness. */
  brandShades: string[];
  /** 10-shade neutral / surface colour ramp, same indexing scheme. */
  neutralShades: string[];
  /** 10-shade secondary brand ramp.  Only populated when the DSL
   *  `theme { secondary: ... }` token is set; otherwise mirrors
   *  `brandShades` so packs that always read `secondaryShades` get
   *  a sensible baseline. */
  secondaryShades: string[];
  /** 10-shade accent ramp (third accent slot). */
  accentShades: string[];
  /** Semantic 10-shade ramps — success / warning / error.  Each
   *  defaults to a pack-agnostic green / amber / red when the DSL
   *  leaves the token blank, so packs that always project these
   *  slots get a coherent baseline. */
  successShades: string[];
  warningShades: string[];
  errorShades: string[];
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
  /** Initial colour scheme — `"light"`, `"dark"`, or `"auto"`.
   *  Packs that support theme toggling read this as the boot-time
   *  default. */
  colorScheme: "light" | "dark" | "auto";
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

// Nav view-models moved to `src/generator/_frontend/menu-emitter.ts`
// (shared with the Svelte app shell); re-exported here so the React
// templates' import path stays stable.
import type { NavSectionVM } from "./menu-emitter.js";

export type { NavEntryVM, NavSectionVM } from "./menu-emitter.js";

/** Top-level view-model for the App.tsx shell. */
export interface AppShellVM {
  /** Humanised system name for the header brand mark. */
  systemNameHuman: string;
  /** Page-component imports the routes refer to. */
  imports: ImportVM[];
  /** Every route the Router renders inside the AppShell chrome, in
   *  source order.  Pages with `layout: none` are routed via
   *  `outOfShellRoutes` instead — they mount at the top of the
   *  router with no header / sidebar / main padding. */
  routes: RouteVM[];
  /** Routes that mount OUTSIDE the AppShell chrome — one per page
   *  that declared `layout: none`.  Rendered as sibling `<Route>`
   *  entries to the AppShell layout-route in App.tsx.  Empty when
   *  no page opted out, in which case the template emits zero
   *  out-of-shell route entries. */
  outOfShellRoutes: RouteVM[];
  /** Phase 8 step 2: one entry per declared named `layout` SystemMember
   *  that's actually referenced by at least one page in this ui.  Each
   *  emits a `function <Name>Layout() { … <Outlet /> … }` component
   *  in App.tsx plus a matching `<Route element={<Name>Layout />}>`
   *  wrapping the routes that opted into it. */
  namedLayouts: NamedLayoutVM[];
  /** True when `namedLayouts.length > 0`.  Drives conditional pack
   *  imports in the AppShell template — Box/Card/Container/Grid/Image/
   *  Badge are pre-imported for layout-slot JSX and are unused (Biome
   *  flags) when no named layouts exist. */
  hasNamedLayouts: boolean;
  /** True when at least one named layout's slot uses programmatic
   *  navigation.  Gates the `useNavigate` import — unused otherwise. */
  anyLayoutUsesNavigate: boolean;
  /** One section per construct kind that has at least one entry. */
  navSections: NavSectionVM[];
  /** Whether the deployable is `auth: ui`.  Drives the per-entry `requiresJs`
   *  wrap (only gated entries carry one). */
  authUi: boolean;
  /** True when `auth: ui` AND at least one nav entry is gated (`requiresJs`).
   *  Gates the `useSession` import + `currentUser` binding so they're emitted
   *  only when actually consumed — an unused binding would be a Biome error in
   *  the generated project.  False ⇒ byte-identical to non-auth output. */
  navUsesSession: boolean;
}

/** A named-layout wrapper view-model.  Each slot's JSX is the
 *  pre-walked output of the layout slot's ExprIR; `hasX` flags let
 *  the template skip empty slots cleanly. */
export interface NamedLayoutVM {
  name: string;
  hasHeader: boolean;
  headerJsx: string;
  hasSidebar: boolean;
  sidebarJsx: string;
  hasFooter: boolean;
  footerJsx: string;
  /** Any slot uses a `Button { to: }` (or other primitive that
   *  lowers to `navigate(...)`).  Template injects
   *  `const navigate = useNavigate()` at the top of the wrapper
   *  function when set. */
  usesNavigate: boolean;
  /** Routes that opted into this layout (page name + path JSX). */
  routes: RouteVM[];
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
  /** Set on a field-array (`X[]` of a value-object / entity part): the
   *  element's sub-field VMs, keyed by their BARE sub-path (`sku`, not
   *  `items.sku`) so a dynamic-row template can splice the runtime index
   *  (`items.${index}.sku`).  Present only for object arrays — a scalar array
   *  leaves it undefined (stub / comma-separated).  A pack template renders
   *  `rowFields` as repeatable rows (React `useFieldArray`, Feliz MVU list …);
   *  a pack that doesn't yet ignores it and keeps the disabled stub. */
  rowFields?: FormFieldVM[];
  /** Humanised singular label for one row (`Line item`) — the add-button text. */
  elementLabel?: string;
  /** Pascal-cased array name (`Items`) — for the hoisted `useFieldArray` var
   *  names a dynamic-row template references (`appendItems` / `removeItems`). */
  arrayPascal?: string;
  /** JSON literal for a fresh appended row (`{ sku: "", qty: 0 }`) — the
   *  argument to RHF `append(...)` in the Add button. */
  defaultRowJson?: string;
  /** Set on a numeric row sub-field so a dynamic-row register uses
   *  `{ valueAsNumber: true }` (RHF coerces the string input to a number, so a
   *  `z.number()` schema validates). */
  valueAsNumber?: boolean;
}
