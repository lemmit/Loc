// ---------------------------------------------------------------------------
// HEEx walker core.
//
// Sibling of src/generator/react/body-walker.ts but emits HEEx for the
// Phoenix LiveView platform.  Same input (`PageIR.body` expression IR),
// different output language.  Follows the repo's existing per-platform
// renderer pattern (cf. dotnet/render-expr.ts vs typescript/render-expr.ts
// — neither delegates through a common interface; they coexist as
// siblings).
//
// What this walker produces, per page:
//
//   - HEEx body string spliced into `def render(assigns), do: ~H"""..."""`
//   - A list of `handle_event/3` clauses derived from operation actions
//     and block-body lambdas (`onSubmit`, `Action(op).then`).
//
// What this walker DOES NOT cover in v0:
//
//   - Full closed-primitive library (Form/Dashboard/Review/
//     Tabs/Grid/Card/Toolbar/Heading/Text/Badge/Stat/
//     Empty/Field/Toggle/Select/Fieldset/Action/Button).  v0 supports
//     the structural set (Stack/Heading/Text/Card/Toolbar/Empty/
//     Badge/Action/Button); the rest emit a HEEx comment with the
//     primitive name so the gap is visible in generated output.
//   - Field input mapping beyond the basics — page-new / page-detail
//     templates handle the heavy lifting; this walker only renders
//     custom-page bodies (PageIR.body without archetype).
//
// State seam:
//   - Template position: `state.step`  → `@step`
//   - Handler position:  `state.step`  → `socket.assigns.step`
//   - Write (in lambda block-body): `state.step := value` →
//                                   `socket = assign(socket, :step, value)`
//
// Match → `cond do … end` (works in both expression and template position).
//
// Navigate → `push_navigate(socket, to: ~p"<route>")` (handler position only).
//
// API binding (`Sales.Customer.create.mutate(args)`) → direct context-module
// call (`<App>.Sales.create_customer!(args)`) — no hook
// hoisting, LiveView reads inline.
// ---------------------------------------------------------------------------

import { variantTag } from "../../ir/stdlib/unions.js";
import type {
  AggregateIR,
  BoundedContextIR,
  ComponentIR,
  EnumIR,
  ExprIR,
  PageIR,
  StateFieldIR,
  StmtIR,
  TypeIR,
  UiIR,
  ValueObjectIR,
} from "../../ir/types/loom-ir.js";
import {
  listShapedProjectionNames,
  readableProjectionNames,
} from "../../ir/util/projection-read.js";
import { intrinsicFor, intrinsicKey } from "../../util/intrinsics.js";
import { elixirString, humanize, snake, upperFirst } from "../../util/naming.js";
import { PROVENANCE_VALUE_FIELD } from "../../util/provenance-carrier.js";
import { DURATION_UNIT_MS, type DurationUnit } from "../../util/temporal.js";
import { USER_VISIBLE_SLOTS } from "../../util/user-visible-slots.js";
import { tryRenderGate } from "../_frontend/gate-expr.js";
import { icuFromConcat, messageKey } from "../_walker/i18n-extract.js";
import { WALKER_PRIMITIVES } from "../_walker/registry.js";
import { heexTarget, renderHeexStoreActionCall, renderHeexStoreFieldRead } from "./heex-target.js";
import { elixirI18nString } from "./i18n.js";
import { ELIXIR_INTRINSIC_RENDERERS } from "./render-expr.js";

export type RenderPosition = "template" | "handler";

export interface HandleEventClause {
  /** Event name as used in `phx-click="..."` / `phx-submit="..."`. */
  name: string;
  /** Elixir parameter pattern after the event name string.
   *  Common shapes: `_params`, `%{"id" => id}`, `%{"form" => form_params}`. */
  paramsPattern: string;
  /** Body lines, indented relative to the `do` block opening. */
  body: string[];
}

export interface WalkResult {
  /** HEEx body string for `def render(assigns), do: ~H""" … """`. */
  heex: string;
  /** `handle_event/3` clauses for the LiveView module body. */
  handlers: HandleEventClause[];
  /** Form bindings discovered inside the page body — one entry per
   *  `CreateForm(of: Agg)` or `WorkflowForm(runs: Wf)` call.  The LiveView emitter
   *  uses this to assign `@form` in `mount/3` via a plain Ecto changeset
   *  (`change_<agg>(...)`) converted with `to_form(...)`.
   *  Empty when the page body has no form. */
  formBindings: FormBinding[];
  /** Query bindings discovered inside the page body — one per
   *  `QueryView(of: …)` call.  The LiveView emitter consumes these
   *  in `handle_params/3` to load `@data` (single/detail) or
   *  `@items` (list) via the aggregate's context module function.
   *  Empty when the page has no QueryView. */
  queryBindings: QueryBinding[];
  /** Action bindings discovered inside the body — one per
   *  `Action(<instance>.<op>)`.  Each yields a `handle_event` clause
   *  in the *host page's* LiveView (a component is a stateless function
   *  component, so its actions are hoisted to every page that uses it). */
  actionBindings: ActionBinding[];
  /** Names of user `component`s invoked in the body, so the LiveView
   *  emitter can hoist their action handlers transitively. */
  usedComponents: string[];
  /** How many times each user `component` is INVOKED in this body (keyed by
   *  component name).  `usedComponents` answers "which", this answers "how
   *  many" — the host emitter multiplies these along the render tree to decide
   *  whether a stateful component has more than one live instance, which the
   *  lift-to-host-assigns model cannot represent (see `hostStateAssign`). */
  componentUses: Map<string, number>;
  /** True when the body renders a `Slot()` (children passthrough), so the
   *  component emitter declares `slot :inner_block` for it. */
  usesSlot: boolean;
  /** True when the body renders a `Chart { … }` — the deployable then emits the
   *  shared `LoomChart` function component the call site invokes (M-T1.3
   *  Phase 4, HEEx leg).  False ⇒ no component file, byte-identical output. */
  usesChart: boolean;
  /** Aggregate names (PascalCase) referenced by `X id` form fields in
   *  this page's body — the LiveView emitter loads each target's
   *  record list in `mount/3` and assigns to
   *  `socket.assigns.<x_snake>_options` so the rendered select can
   *  read `options={@<x_snake>_options}`.  Empty when no `X id` form
   *  field appears. */
  idOptionsBindings: string[];
  /** Store names (PascalCase) this page/component body uses — a `Cart.<field>`
   *  read or a `Cart.<action>(…)` call anywhere in the body (Stage 5).  The
   *  LiveView emitter seeds one `assign(:<store_snake>, %<Store>{})` per used
   *  store in `mount/3` and adds the matching `alias <App>Web.Stores.<Store>`.
   *  Empty when the body touches no store. */
  usedStores: string[];
  /** `FileUpload { …, bind: <File state> }` inputs in this body — the emitter
   *  wires each into an `allow_upload/3` (mount) + `handle_<field>_progress/3`
   *  consumer.  Empty when the body has no FileUpload. */
  uploadBindings: UploadBinding[];
  /** Interactive `Table(...)` controls in this body (M-T1.1 HEEx leg) — the
   *  emitter hoists the matching sort/page `handle_event` clauses.  Empty when
   *  no Table asked for sorting or paging. */
  tableControls: TableControlBinding[];
}

/** `Action(<instance>.<operation>)` → a `<.button phx-click=…>` plus a
 *  hoisted `handle_event` that loads the instance and invokes the
 *  operation. */
export interface ActionBinding {
  /** Owning aggregate, PascalCase. */
  agg: string;
  /** Operation name, snake_case. */
  op: string;
  /** Human-readable operation label for the flash message. */
  opHuman: string;
  /** `phx-click` event name (`<op>_<agg>`); also the code-interface fn. */
  eventName: string;
  /** Optional `then: navigate(<Page>)` target route. */
  thenRoute?: string;
  /** When set, the handler calls `<eventName>!(id)` directly with the route
   *  id (the context function does the lookup by id), rather than
   *  loading a record first.  Used by `DestroyForm`, whose `destroy_<agg>`
   *  function takes the id (matching the REST controller's destroy call). */
  byId?: boolean;
}

export interface FormBinding {
  /** Which kind of source the form is bound to. */
  kind: "aggregate" | "workflow" | "operation";
  /** Source name in PascalCase (e.g. "Customer", "PlaceOrder"; for
   *  an operation form, the owning aggregate). */
  name: string;
  /** kind:"operation" only — snake-cased operation name (the
   *  `<op>` function the form submits to). */
  op?: string;
  /** kind:"operation" only — deterministic DOM id for the
   *  `<.modal>` wrapping the operation form. */
  modalId?: string;
  /** kind:"operation" only — the operation's params, for `<.input>`
   *  emission and the changeset-backed form. */
  params?: readonly { name: string; type: TypeIR }[];
}

export interface QueryBinding {
  /** "single" → detail page (loads one record into `@data`);
   *  "list" → list page (loads the collection into `@items`). */
  kind: "single" | "list";
  /** LiveView assign the page's `cond` reads ("data" / "items"). */
  assign: string;
  /** Aggregate PascalCase name resolved from the `of:` query call,
   *  used to build the `<Ctx>.get_<agg>!` / `list_<agg>s` call.  For
   *  `source: "projection"` this carries the PROJECTION name instead — the
   *  read resolves to `<Ctx>.QueryProjections.<Proj>.run/1`. */
  aggregate: string;
  /** Which declaration `aggregate` names, and therefore which load the emitter
   *  builds (M-T1.3 Phase 1, HEEx leg).  `"aggregate"` (the default, and every
   *  binding before projections were readable) → the repository read;
   *  `"projection"` → the query-time projection's `run/1`, an IN-PROCESS call:
   *  a LiveView deployable hosts its contexts in the SAME OTP app, so the
   *  Phoenix leg needs no HTTP client at all — the four SPA frontends' whole
   *  `api/projections` module collapses to one function call here.
   *
   *  `"history"` → the derived entity-history read (`<Agg>.history(id)`,
   *  docs/audit.md), which is neither the aggregate's table nor a projection:
   *  it scans `audit_records` for one target.  It gets its own source because
   *  binding it as an ordinary aggregate read is precisely the misbinding this
   *  tag prevents — `list_<aggs>` is the LIST, not the trail.  `aggregate`
   *  carries the audited aggregate's name; `listArgs[0]` is the entity id. */
  source?: "aggregate" | "projection" | "history";
  /** Arguments of the `of:` query call, rendered as HANDLER-position Elixir
   *  (state refs become `socket.assigns.<field>`, not `@<field>`) — the load
   *  block is a function body, not a template.
   *
   *  The scaffold's paged list emits `<api>.<Agg>.all(pageNum, 10, sortKey,
   *  sortDir)`; these are that arg list, forwarded to the repository's paged
   *  `list/4`.  Dropping them (the pre-M-T1.1-slice-8 behaviour) silently fell
   *  back to `list/4`'s defaults, pinning every Phoenix list to page 1 with no
   *  way to reach row 11.  Empty/undefined for a bare `all` → `list_<agg>s()`,
   *  byte-identical to before. */
  listArgs?: string[];
}

/** Interactive controls a `Table(...)` in this body asked for — the HEEx leg of
 *  M-T1.1.  Recorded by `renderTable` so the LiveView emitter can hoist the
 *  matching `handle_event("loom-sort"/"loom-page", …)` clauses; the markup
 *  (sortable header buttons, the pager) is emitted by `renderTable` itself.
 *
 *  Unlike the JSX targets — which sort and slice a bound array in the browser —
 *  the Phoenix leg is SERVER-driven: a LiveView calls its context function
 *  directly, so a sort/page change just re-runs `list_<agg>s/4` with different
 *  arguments and lets the already-whitelisted `ORDER BY` + `LIMIT`/`OFFSET` do
 *  the work.  Absent (no Table, or a Table with no control args) ⇒ no clauses,
 *  byte-identical output. */
export interface TableControlBinding {
  /** snake-cased state assign holding the sorted field name, when the Table
   *  carries `sortKey:`/`sortDir:` refs. */
  sortKey?: string;
  /** snake-cased state assign holding `"asc"` / `"desc"`. */
  sortDir?: string;
  /** snake-cased state assign holding the 1-based page number, when the Table
   *  carries a `page:` ref. */
  page?: string;
}

/** A `FileUpload { …, bind: <File state> }` in a page body — the LiveView
 *  native analogue of the JSX POST-then-bind flow.  The emitter turns each
 *  into an `allow_upload(:<field>, …, auto_upload: true, progress:
 *  &handle_<field>_progress/3)` in `mount/3` plus a `handle_<field>_progress/3`
 *  consumer that persists the entry and assigns the resulting `FileRef` map
 *  into the bound `:<field>` state assign.  See `renderFileUpload`
 *  (heex-primitives.ts) and `renderMount` / `renderUploadProgressHandlers`
 *  (liveview-emit.ts). */
export interface UploadBinding {
  /** snake-cased page-state field the FileRef is written into — also the
   *  `allow_upload` key and the `@uploads.<field>` template reference. */
  field: string;
}

export interface WalkContext {
  /** App's module prefix, e.g. "PhoenixApp" — used for context-module
   *  call qualification (`PhoenixApp.Sales.create_customer!(...)`). */
  appModule: string;
  /** Aggregate registry keyed by PascalCase name — supplied by the
   *  orchestrator so `CreateForm(of: Agg)` can look up the aggregate's
   *  fields and emit one `<.input>` per field rather than a single
   *  hardcoded placeholder.  Empty map = no lookup available
   *  (validators upstream will catch missing aggregates). */
  aggregatesByName: ReadonlyMap<string, AggregateIR>;
  /** Aggregate PascalCase name → its owning bounded context, so a `QueryView`
   *  `of:` read can be resolved to the repository find behind it.  That is what
   *  `queryShape` needs to DERIVE whether the read is paged and whether it
   *  yields one record — facts the LiveView renderer previously took from the
   *  author's `paged:` / `single:` flags alone, and got wrong whenever they
   *  were absent.  Empty default ⇒ the collection shape, i.e. the old
   *  behaviour. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR>;
  /** Frontend-readable projection names (M-T1.3 Phase 1) — the detector's
   *  Pattern H set, so `QueryView { of: <api>.<Projection> }` resolves to the
   *  projection's own read instead of falling through to the aggregate arms.
   *  Derived at walker entry from `bcByAggregate`, the same single predicate
   *  (`ir/util/projection-read.ts`) the JSX walker and the validator use. */
  projectionsByName: ReadonlySet<string>;
  /** The LIST-shaped subset of `projectionsByName` — the reads whose response
   *  is a JSON array rather than one object (`projectionReadShape === "many"`).
   *  Feeds `queryShape`'s single-vs-collection answer. */
  listShapedProjections: ReadonlySet<string>;
  /** Workspace-wide enum registry — drives `renderFieldInputForField`
   *  dispatch for enum-typed fields to `<.input type="select" options={...}>`.
   *  Built once at walker entry from every loaded context's enums. */
  enumsByName: ReadonlyMap<string, EnumIR>;
  /** Workspace-wide value-object registry — drives
   *  `renderFieldInputForField` dispatch for VO-typed fields to
   *  `<.inputs_for :let={…}>` nested forms.  Built once at walker
   *  entry from every loaded context's value objects. */
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR>;
  /** Set of aggregate names (PascalCase) referenced by `X id` form
   *  fields in this page's body — drives mount-time option-list
   *  loading.  For each binding, `renderMount` emits
   *  `socket |> assign(:<x_snake>_options, <ctx>.list_<x_snake>s!() |> Enum.map(...))`
   *  so the rendered select's `options={@<x_snake>_options}` resolves.
   *  Populated lazily as the walker visits Form / OperationForm bodies. */
  idOptionsBindings: Set<string>;
  /** Form bindings discovered as the walker visits `Form(...)` calls. */
  formBindings: FormBinding[];
  /** Query bindings discovered as the walker visits `QueryView(...)`. */
  queryBindings: QueryBinding[];
  /** PageIR being walked — its `state[]` drives state-reference resolution
   *  and its `params[]` resolves route-param refs. */
  page: PageIR;
  /** UI block enclosing the page — its `helperImports[]` resolves
   *  user-helper references. */
  ui: UiIR;
  /** Local name set for `state { … }` fields (snake-cased). */
  stateNames: Set<string>;
  /** Per-field StateFieldIR keyed by snake-cased name.  Drives
   *  `heexTarget.renderStateRead` delegation — the contract's
   *  `StateRef` carries the full field, but the walker historically
   *  carried only the name set.  Built once at walker entry next
   *  to `stateNames` so lookups stay symmetric. */
  stateFields: Map<string, StateFieldIR>;
  /** Accumulated handle_event clauses. */
  handlers: HandleEventClause[];
  /** Accumulated `Action(...)` bindings (hoisted to the host LiveView). */
  actionBindings: ActionBinding[];
  /** Names of user components invoked while walking this body. */
  usedComponents: Set<string>;
  /** Invocation COUNT per user component in this body — see
   *  `WalkResult.componentUses`. */
  componentUses: Map<string, number>;
  /** The `component` whose `state { … }` / `action` this body owns, when the
   *  body being walked is a component's rather than a page's.  A HEEx function
   *  component is stateless, so its state lives in the HOST LiveView's assigns
   *  under `hostStateAssign(owner, field)` and flows back down as an attr of
   *  that same name.  Undefined for a page body — page state keeps its bare
   *  assign name. */
  stateOwner?: string;
  /** Rendered-source substitutions for an INLINED action call's parameters
   *  (`setLabel("hi")` inlining `action setLabel(v: string)`): param name →
   *  already-rendered Elixir expression, applied at `ref` resolution.  LiveView
   *  cannot call one `handle_event` clause from another, so a parameterised
   *  sibling action is inlined with its arguments substituted. */
  actionArgSubst?: ReadonlyMap<string, string>;
  /** Shared box flag set by `Slot()` rendering — boxed so the mutation
   *  survives the `{...ctx}` shallow copies nested renders make (like the
   *  Set/array accumulators above). */
  slotUsed: { value: boolean };
  /** Shared box flag set when a `Chart { … }` renders — boxed for the same
   *  reason as `slotUsed`.  Drives the per-deployable `LoomChart` component
   *  emission (the chart's SVG geometry is Elixir arithmetic, not markup). */
  chartUsed: { value: boolean };
  /** Monotonic per-page counter for `Tabs` instances — boxed (survives the
   *  `{...ctx}` copies) so each Tabs gets a unique id used to scope its
   *  client-side `JS.show`/`JS.hide` toggle selectors. */
  tabSeq: { value: number };
  /** Monotonic per-page counter for `Table` instances WITHOUT an explicit
   *  `testid:` — boxed for the same reason as `tabSeq`.  `<.table>` requires a
   *  DOM `id` (the Phoenix.Component contract), and every default-id table on a
   *  page emitting the same `id="data-table"` breaks LiveView DOM patching and
   *  duplicates the id for assistive tech.  Rare before projections were
   *  readable (one list per page); routine after, since a dashboard page reads
   *  several projections side by side.  The FIRST table keeps the bare
   *  `data-table`, so single-table pages stay byte-identical. */
  tableSeq: { value: number };
  /** Store names (PascalCase) referenced anywhere in this body — a
   *  `Cart.<field>` read or `Cart.<action>(…)` call (Stage 5).  A Set so the
   *  mutation survives the `{...ctx}` shallow copies nested renders make (like
   *  the other accumulator Sets above), surfaced as `WalkResult.usedStores`. */
  usedStores: Set<string>;
  /** FileUpload bindings discovered as the walker visits `FileUpload(…)` calls
   *  (heex-primitives.ts::renderFileUpload).  Surfaced as
   *  `WalkResult.uploadBindings`; drives mount `allow_upload` + the progress
   *  consumer.  An array (mutation survives `{...ctx}` shallow copies, like the
   *  other accumulator arrays above). */
  uploadBindings: UploadBinding[];
  /** Table control bindings discovered as the walker visits `Table(…)` calls
   *  (heex-primitives.ts::renderTable).  Surfaced as `WalkResult.tableControls`;
   *  drives the hoisted sort/page `handle_event` clauses.  An array (mutation
   *  survives `{...ctx}` shallow copies, like the other accumulators above). */
  tableControls: TableControlBinding[];
  /** Current rendering position — see RenderPosition. */
  position: RenderPosition;
  /** Module-qualified bounded-context name keyed by entity-part name
   *  (PascalCase) — e.g. `Line` → `PhoenixApp.Sales`.  Lets a page-body
   *  `new Part { … }` struct literal qualify like the domain emitter does
   *  (`%PhoenixApp.Sales.Line{…}`).  Empty when the orchestrator hasn't
   *  threaded it; the `new` arm then falls back to `appModule`. */
  partContextModule: ReadonlyMap<string, string>;
  /** Aggregate PascalCase name → module-qualified context (e.g. `Order` →
   *  `PhoenixApp.Sales`).  Lets an awaited `match await <api>.<Agg>.<op>(…)`
   *  action body (async-actions-and-effects.md Stage 2) qualify the server-side
   *  returning-op context call (`<Ctx>.<op>_<agg>(record, params)`) + the
   *  route-id record load (`<Ctx>.get_<agg>(id)`).  Empty ⇒ falls back to
   *  `appModule` (still valid Elixir; only awaited variant-match consumes it). */
  contextModuleByAggName: ReadonlyMap<string, string>;
  /** Optional variable remappings — maps a source ref name to the LiveView
   *  assign name it should resolve to.  Used by QueryView to map lambda
   *  parameter names (e.g. "rows") to their assign names (e.g. "items"). */
  varRemapping?: ReadonlyMap<string, string>;
  /** Sibling action names currently being inlined (Proposal A Stage 1, Fix 1).
   *  A `target: "action"` call inlines the callee's body pipe-steps in place;
   *  this guards against an `A → B → A` cycle re-entering an action already on
   *  the stack (validation would normally catch the cycle, but codegen must
   *  not infinite-loop). */
  actionInlineStack?: ReadonlySet<string>;
  /** In-scope instance variable → aggregate name, for instance-qualified
   *  operation forms (`OperationForm(data.confirm)`).  Populated when QueryView
   *  walks its single-record `data:` lambda. */
  instanceTypes?: ReadonlyMap<string, string>;
  /** True when the host deployable runs `auth: required` — so
   *  `LiveAuth.on_mount` assigns `@current_user` into the LiveView scope.
   *  Gates an `Action(<instance>.<op>)` button whose operation's `requires`
   *  predicates are all currentUser-only: the `<.button>` is wrapped in a
   *  HEEx `<%= if (@current_user.…) do %> … <% end %>` so it's hidden
   *  server-side when the gate fails (the operation still enforces it).
   *  False ⇒ no `@current_user` exists, so NO gating is emitted and the
   *  button stays byte-identical. */
  authEnabled?: boolean;
  /** Section/Card nesting depth, so a `Heading` with no explicit `level:`
   *  derives its rank from structure — `min(6, 2 + headingDepth)`, matching
   *  the JSX frontends' `WalkEnv.headingDepth` (accessibility.md Phase 2, so
   *  ranks never skip).  Incremented by `renderSection` / `renderCard` for
   *  their children; undefined at page top ⇒ depth 0 ⇒ `<h2>` (the app shell
   *  owns the single `<h1>`). */
  headingDepth?: number;
  /** i18n key prefix for this body — `page.<Page>` / `component.<Comp>`
   *  (M-T1.11).  Set only when the ui has extractable user-visible strings;
   *  undefined ⇒ every literal renders raw (byte-identical to pre-i18n).
   *  The HEEx engine is a FORK of the shared walker, so this mirrors
   *  `_walker/walker-core.ts`'s `i18nPrefix` rather than sharing it. */
  i18nPrefix?: string;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export function walkBodyToHeex(
  body: ExprIR | undefined,
  page: PageIR,
  ui: UiIR,
  appModule: string,
  aggregatesByName: ReadonlyMap<string, AggregateIR> = new Map(),
  /** Workspace-wide enum registry — drives `renderFieldInputForField`
   *  dispatch for enum-typed fields to `<.input type="select">`.
   *  Defaults to empty when callers haven't threaded enums yet; the
   *  walker falls back to `text` input as before.  See the matching
   *  `aggregatesByName` plumbing for how to populate. */
  enumsByName: ReadonlyMap<string, EnumIR> = new Map(),
  /** Workspace-wide VO registry — drives `renderFieldInputForField`
   *  dispatch for value-object-typed fields to `<.inputs_for :let={…}>`
   *  nested-form blocks.  Defaults to empty when callers haven't
   *  threaded VOs yet; the walker falls back to text input. */
  valueObjectsByName: ReadonlyMap<string, ValueObjectIR> = new Map(),
  /** True when the host deployable runs `auth: required` — drives
   *  action-button gating against `@current_user`.  Defaults to false
   *  (no auth ⇒ no gating ⇒ byte-identical output). */
  authEnabled = false,
  /** Entity-part name → module-qualified context, so a page-body
   *  `new Part { … }` qualifies like the domain emitter.  Empty default
   *  ⇒ the `new` arm falls back to `appModule`. */
  partContextModule: ReadonlyMap<string, string> = new Map(),
  /** Aggregate PascalCase name → module-qualified context, for the awaited
   *  `match await` server-side op call (Stage 2).  Empty default ⇒ falls back
   *  to `appModule`. */
  contextModuleByAggName: ReadonlyMap<string, string> = new Map(),
  /** Aggregate → owning bounded context, for `queryShape`'s find lookup.
   *  Empty default ⇒ QueryView falls back to the author's flags alone. */
  bcByAggregate: ReadonlyMap<string, BoundedContextIR> = new Map(),
  /** i18n key prefix (M-T1.11) — `page.<Name>` / `component.<Name>`, matching
   *  the shared catalog.  Undefined ⇒ no translation, byte-identical. */
  i18nPrefix: string | undefined = undefined,
  /** Name of the `component` this body belongs to, when walking a component
   *  rather than a page.  Namespaces the lifted state assigns (and the
   *  synthesized lambda event names) so two components can each declare `n`
   *  without colliding in the host LiveView.  Undefined for a page body ⇒
   *  byte-identical to the pre-lift output. */
  stateOwner: string | undefined = undefined,
): WalkResult {
  const stateNames = new Set<string>(page.state.map((f) => snake(f.name)));
  const stateFields = new Map<string, StateFieldIR>(page.state.map((f) => [snake(f.name), f]));
  // Seed instance types from aggregate-typed params so `Action(p.op)` /
  // `Form(p.op)` resolve the operation's aggregate.  A component param
  // `order: Order` → `order → "Order"`; QueryView extends this for its
  // single-record `data:` lambda.
  const instanceTypes = new Map<string, string>();
  for (const p of page.params) {
    if (p.type.kind === "entity" && aggregatesByName.has(p.type.name)) {
      instanceTypes.set(p.name, p.type.name);
    }
  }
  const ctx: WalkContext = {
    appModule,
    aggregatesByName,
    bcByAggregate,
    // Both derived from the ONE readability predicate, never re-decided here —
    // the walker, the client emitter and the validator gate disagreeing about
    // which projections are readable is the exact defect `projection-read.ts`
    // exists to prevent.
    projectionsByName: readableProjectionNames(new Set(bcByAggregate.values())),
    listShapedProjections: listShapedProjectionNames(new Set(bcByAggregate.values())),
    enumsByName,
    valueObjectsByName,
    idOptionsBindings: new Set(),
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames,
    stateFields,
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    componentUses: new Map(),
    stateOwner,
    slotUsed: { value: false },
    chartUsed: { value: false },
    tabSeq: { value: 0 },
    tableSeq: { value: 0 },
    usedStores: new Set(),
    uploadBindings: [],
    tableControls: [],
    position: "template",
    instanceTypes,
    authEnabled,
    partContextModule,
    contextModuleByAggName,
    i18nPrefix,
  };

  // Hoist named page `action`s (named-actions-and-stores.md, Proposal A
  // Stage 1) into `handle_event` clauses named `snake(action.name)`, so a
  // bare `onClick: next` reference — lowered to an `action-ref` ExprIR that
  // renders to `snake(name)` — binds to a real clause.  Mirrors the inline-
  // lambda hoist (`hoistLambdaToHandler`) but keyed by the declared name.
  // Guarded with `?? []`: component synth-pages carry no `actions`.
  for (const action of page.actions ?? []) {
    const bodyLines: string[] = [`    socket =`, `      socket`];
    for (const s of action.body) bodyLines.push(`      ${renderStmt(s, ctx)}`);
    bodyLines.push(`    {:noreply, socket}`);
    ctx.handlers.push({ name: snake(action.name), paramsPattern: "_params", body: bodyLines });
  }

  // Direct store-action handlers (`onClick: Cart.clear`) — a bare store-action
  // reference used as a handler has no matching page `action`, so the button's
  // `phx-click="clear"` would dangle without a clause.  Synthesize the clause
  // (dispatch the store action over its per-page assign) exactly like a page
  // action whose body is the single store-action call, so it is byte-identical
  // to the wrapped `action discard() { Cart.clear() }` idiom.  Deduped by event
  // name so a store action onClicked twice (or one also called from a page
  // action) emits one clause.
  const existingHandlers = new Set(ctx.handlers.map((h) => h.name));
  for (const { store, action } of collectStoreActionRefs(body)) {
    const name = snake(action);
    if (existingHandlers.has(name)) continue;
    existingHandlers.add(name);
    ctx.usedStores.add(store);
    const call: StmtIR = {
      kind: "call",
      target: "store-action",
      name: action,
      args: [],
      store,
    };
    ctx.handlers.push({
      name,
      paramsPattern: "_params",
      body: [
        `    socket =`,
        `      socket`,
        `      ${renderStmt(call, ctx)}`,
        `    {:noreply, socket}`,
      ],
    });
  }

  const heex = body ? renderExpr(body, ctx) : `<!-- empty body -->`;

  return {
    heex,
    handlers: ctx.handlers,
    formBindings: ctx.formBindings,
    queryBindings: ctx.queryBindings,
    actionBindings: ctx.actionBindings,
    usedComponents: [...ctx.usedComponents],
    componentUses: ctx.componentUses,
    usesSlot: ctx.slotUsed.value,
    usesChart: ctx.chartUsed.value,
    idOptionsBindings: [...ctx.idOptionsBindings],
    usedStores: [...ctx.usedStores],
    uploadBindings: ctx.uploadBindings,
    tableControls: ctx.tableControls,
  };
}

/** Collect the bare store-action handler references (`action-ref` with a
 *  `storeName`, e.g. `onClick: Cart.clear`) reachable in a page body, deduped
 *  by `<store>.<action>`.  Used to synthesize their `handle_event` clauses —
 *  the parallel HEEx walker's analogue of the JSX shell binding a store-action
 *  local. */
function collectStoreActionRefs(root: ExprIR | undefined): { store: string; action: string }[] {
  const out: { store: string; action: string }[] = [];
  const seen = new Set<string>();
  const visit = (e: ExprIR | undefined): void => {
    if (!e || typeof e !== "object") return;
    if (e.kind === "action-ref" && e.storeName) {
      const key = `${e.storeName}.${e.actionName}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ store: e.storeName, action: e.actionName });
      }
    }
    // Recurse structurally — visit every ExprIR-typed child field.
    for (const v of Object.values(e as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const el of v) visit(el as ExprIR);
      else if (v && typeof v === "object" && "kind" in (v as object)) visit(v as ExprIR);
    }
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// Expression dispatch.
// ---------------------------------------------------------------------------

export function renderExpr(expr: ExprIR, ctx: WalkContext): string {
  switch (expr.kind) {
    case "literal":
      return renderLiteral(expr.lit, expr.value);
    case "this":
      // Outside an aggregate body — `this` in a page context refers to
      // the page's primary data binding.  v0: emit as `@record` and
      // rely on the LiveView's mount to assign it.
      return ctx.position === "template" ? "@record" : "socket.assigns.record";
    case "id":
      return ctx.position === "template" ? "@id" : "socket.assigns.id";
    case "ref":
      return renderRef(expr, ctx);
    case "member":
      return renderMember(expr, ctx);
    case "method-call":
      return renderMethodCall(expr, ctx);
    case "call":
      return renderCall(expr, ctx);
    case "lambda":
      // Lambdas only appear as argument values (onSubmit, onClick, etc.).
      // The walker hoists each lambda into a handle_event clause and
      // returns the phx-event name to wire into the parent attribute.
      return hoistLambdaToHandler(expr, ctx);
    case "object":
      return renderObjectLiteral(expr, ctx);
    case "new":
      return renderNew(expr, ctx);
    case "paren":
      return `(${renderExpr(expr.inner, ctx)})`;
    case "unary":
      if (expr.op === "!") return `not ${renderExpr(expr.operand, ctx)}`;
      return `-${renderExpr(expr.operand, ctx)}`;
    case "binary":
      return renderBinary(expr, ctx);
    case "ternary":
      return `if ${renderExpr(expr.cond, ctx)}, do: ${renderExpr(expr.then, ctx)}, else: ${renderExpr(expr.otherwise, ctx)}`;
    case "convert": {
      // Phoenix HEEx conversion — mirror the renderExpr emit in
      // `elixir/render-expr.ts`.  HEEx pages embed Elixir
      // expressions verbatim inside `<%= … %>`, so the same Elixir
      // idioms apply (Decimal.to_string for money, to_string for
      // primitives, Decimal.new for the inverse).
      const v = renderExpr(expr.value, ctx);
      // money AND decimal are Decimal structs here — mirror render-expr.ts's
      // `renderElixirConvert` exactly.
      const fromDecimal = expr.from === "money" || expr.from === "decimal";
      if (expr.target === "string") {
        if (fromDecimal) return `Decimal.to_string(${v})`;
        return `to_string(${v})`;
      }
      if (expr.target === "long" || expr.target === "int") {
        if (fromDecimal) return `Decimal.to_integer(Decimal.round(${v}, 0, :down))`;
        return v;
      }
      if (expr.target === "decimal" || expr.target === "money") {
        if (fromDecimal) return v;
        return `Decimal.new(${v})`;
      }
      return v;
    }
    case "duration":
      // A5 temporal — an absolute duration is plain integer MILLISECONDS
      // (mirrors the domain renderer, `render-expr.ts`).  Duration values
      // rarely reach a page body (they mostly arise in domain expressions),
      // but a page-level `dt + days(n)` is valid DSL.
      return renderDuration(expr.unit, renderExpr(expr.amount, ctx));
    case "i18nFormat":
      // Transparent i18n wrapper (M-T1.11) — LiveView has no client-side i18n
      // runtime, so the format is dropped: render the wrapped operand, exactly
      // as a format-less hole would render.
      return renderExpr(expr.inner, ctx);
    case "match":
      return renderMatch(expr, ctx);
    case "list":
      // List literals are walker-config sugar (e.g. responsive Grid cols).
      // No HEEx page-body emit path consumes one today; emit a literal
      // Elixir list so unexpected uses produce valid Elixir.
      return `[${expr.elements.map((el) => renderExpr(el, ctx)).join(", ")}]`;
    case "action-ref":
      // Named-action reference (named-actions-and-stores.md, Proposal A
      // Stage 1).  A handler-arg referencing a named page `action`.  Returns
      // the bare phx-event name — `snake(actionName)` — exactly like the
      // inline-lambda hoist (`hoistLambdaToHandler` returns `event_N`); the
      // matching `handle_event` clause is hoisted from `page.actions` at the
      // top of `walkBodyToHeex`.  (Component-level actions, like component-
      // level lambdas, do not hoist to the host LiveView — a pre-existing
      // HEEx limitation tracked by the parity gate.)
      return snake(expr.actionName);
    case "authz-filter":
      // Authorization/tenancy filter sentinel (M-T9.9) — a query-filter node,
      // never a page-body expression.  Reaching the HEEx page renderer means it
      // leaked from a filter position; throw rather than emit invalid markup.
      throw new Error("heex renderExpr: 'authz-filter' is not a page-body expression");
  }
}

function renderLiteral(kind: string, value: string): string {
  switch (kind) {
    case "string":
      // value already has source quoting stripped; re-quote for Elixir,
      // escaping `#{` so a `.ddd` string can't inject Elixir interpolation.
      return elixirString(value);
    case "int":
      return value;
    case "decimal":
    case "money":
      // Both decimal and money literals are Decimal structs; emit a
      // `Decimal.new("…")` call.  The HEEx template embeds it via
      // `<%= … %>` so the precise value is rendered as the canonical
      // decimal string at request time.
      return `Decimal.new(${JSON.stringify(value)})`;
    case "bool":
      return value === "true" ? "true" : "false";
    case "null":
      return "nil";
    case "now":
      return "DateTime.utc_now()";
    default:
      return value;
  }
}

function renderRef(expr: Extract<ExprIR, { kind: "ref" }>, ctx: WalkContext): string {
  // Parameter of an INLINED sibling action (`go() { setLabel("hi") }`) — the
  // caller's argument, already rendered in the CALLER's scope.  Parenthesised
  // so substituting an operator expression into a larger one stays safe.
  const subst = ctx.actionArgSubst?.get(expr.name);
  if (subst !== undefined) return `(${subst})`;
  // Store-field read — `Cart.count` (Stage 5).  Resolved at lowering into a
  // `ref` carrying `refKind: "store-field"` + the declaring `storeName`.  In a
  // page/component body it reads the store's per-page assign
  // (`@cart.count` / `socket.assigns.cart.count`); record the use so the
  // LiveView emitter seeds the assign + alias.  (A store action's OWN field
  // reads use the bare field name, never `Store.field`, so they don't land
  // here — they're handled by the store-module emitter.)
  if (expr.refKind === "store-field" && expr.storeName) {
    ctx.usedStores.add(expr.storeName);
    return renderHeexStoreFieldRead(expr.storeName, expr.name, ctx.position);
  }
  // Variable remapping — QueryView maps lambda params (e.g. "rows") to
  // their LiveView assign names (e.g. "items").  Check this first.
  if (ctx.varRemapping) {
    const remapped = ctx.varRemapping.get(snake(expr.name));
    if (remapped !== undefined) {
      return ctx.position === "template" ? `@${remapped}` : `socket.assigns.${remapped}`;
    }
  }
  // State field — position-dependent.
  if (ctx.stateNames.has(snake(expr.name))) {
    // Delegated to heexTarget.renderStateRead — see
    // `src/generator/_walker/target.ts`.  Walker looks the full
    // StateFieldIR up by snake-cased name (built once at walker
    // entry) and passes through; the target snake-cases the name
    // itself and dispatches by position.
    // A component's state is lifted into the HOST LiveView's assigns and flows
    // back down as an attr of the same (namespaced) name, so BOTH positions use
    // `hostStateAssign` — `@counter_n` in the component template, and
    // `socket.assigns.counter_n` in the handler the host hoisted.
    const assignName = hostStateAssign(ctx.stateOwner, expr.name);
    const field = ctx.stateFields.get(snake(expr.name));
    if (field) {
      return heexTarget.renderStateRead({ field, name: assignName }, ctx.position);
    }
    // Fallback to legacy path if the field isn't in the map (shouldn't
    // happen — stateNames and stateFields are populated together at
    // walker entry).  Behavior-identical to delegation.
    return ctx.position === "template" ? `@${assignName}` : `socket.assigns.${assignName}`;
  }
  // Page/component `derived` binding — LiveView has no render-scope hoist
  // site, so we INLINE-RECOMPUTE: substitute the derived's expr at each
  // use (LiveView re-renders on assign change, so each use stays fresh; a
  // derived referencing an earlier derived resolves via this same
  // substitution; the lowering forbids cycles).  Parenthesised to keep
  // precedence safe when the binding sits inside a larger expression.
  const derivedHit = ctx.page.derived?.find((d) => snake(d.name) === snake(expr.name));
  if (derivedHit) {
    return `(${renderExpr(derivedHit.expr, ctx)})`;
  }
  // Page route param.
  if (ctx.page.params.some((p) => p.name === expr.name)) {
    return ctx.position === "template"
      ? `@${snake(expr.name)}`
      : `socket.assigns.${snake(expr.name)}`;
  }
  switch (expr.refKind) {
    case "param":
    case "let":
    case "lambda":
      return snake(expr.name);
    case "enum-value":
      // Declared casing, never snake: the loaded struct field is the
      // declared-case `Ecto.Enum` atom (see render-expr.ts's enum-value arm) —
      // `:public` would never equal `:Public`, silently failing the comparison.
      return `:${expr.name}`;
    case "current-user":
      return ctx.position === "template" ? `@current_user` : `socket.assigns.current_user`;
    case "helper-fn":
      return snake(expr.name);
    default:
      return snake(expr.name);
  }
}

function renderMember(expr: Extract<ExprIR, { kind: "member" }>, ctx: WalkContext): string {
  // Map well-known property accesses to their Elixir analogs.
  if (expr.member === "length" || expr.member === "count") {
    return `Enum.count(${renderExpr(expr.receiver, ctx)})`;
  }
  if (expr.receiver.kind === "ref" && expr.receiver.refKind === "current-user") {
    const cu = ctx.position === "template" ? "@current_user" : "socket.assigns.current_user";
    return `${cu}.${snake(expr.member)}`;
  }
  // HEEx is the exception to "read the wire" (docs/provenance.md): LiveView
  // renders server-side straight off the Ecto struct, which keeps a provenanced
  // field SPLIT into its value column and its `<field>_provenance` jsonb
  // sibling.  The `Provenanced<T>` carrier (M-T6.12) is a WIRE shape, so the
  // `.value` hop the page body spells for every JSON frontend has nothing to
  // step into here — `@data.total.value` would raise on an integer.  Drop the
  // hop and read the column, exactly as `renderProvenanceInfo` reads the
  // sibling column rather than the carrier's `lineage`.
  if (
    expr.member === PROVENANCE_VALUE_FIELD &&
    expr.receiver.kind === "member" &&
    provenancedFieldNames(ctx).has(expr.receiver.member)
  ) {
    return renderExpr(expr.receiver, ctx);
  }
  return `${renderExpr(expr.receiver, ctx)}.${snake(expr.member)}`;
}

/** Every `provenanced` field NAME declared by an aggregate (or entity part) in
 *  scope.  A page body carries unresolved receiver types (`walker-core.ts`
 *  documents the same limitation for the JSX walkers), so the carrier hop is
 *  recognised by field NAME rather than by type.  The residual ambiguity — a
 *  value object that happens to declare a field with the same name AS WELL AS a
 *  sub-field literally called `value` — is narrow, and the mis-render it would
 *  cause is a dropped `.value`, not a wrong value. */
function provenancedFieldNames(ctx: WalkContext): ReadonlySet<string> {
  const cached = provNamesCache.get(ctx.aggregatesByName);
  if (cached) return cached;
  const names = new Set<string>();
  for (const agg of ctx.aggregatesByName.values()) {
    for (const f of agg.fields) if (f.provenanced) names.add(f.name);
    for (const p of agg.parts) for (const f of p.fields) if (f.provenanced) names.add(f.name);
  }
  provNamesCache.set(ctx.aggregatesByName, names);
  return names;
}

const provNamesCache = new WeakMap<ReadonlyMap<string, AggregateIR>, ReadonlySet<string>>();

/** JS-frontend collection ops that aren't in the shared `isCollectionOp`
 *  catalogue (`src/util/collection-ops.ts`) but DO render verbatim on the
 *  JS frontends via `emitExpr` (native `Array.prototype` methods).  In a
 *  page body these reach HEEx as a `method-call` whose first arg is a
 *  lambda; without this routing their lambda would be hoisted to a
 *  `handle_event` clause and the op emitted as an invalid `recv.filter(…)`
 *  chain.  `renderCollectionOp` already shapes them into `Enum.filter/2` /
 *  `Enum.map/2` — they just weren't reaching it (DEBT-31). */
const INLINE_LAMBDA_COLLECTION_OPS: ReadonlySet<string> = new Set(["filter", "map", "select"]);

function renderMethodCall(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): string {
  if (
    expr.isCollectionOp ||
    (INLINE_LAMBDA_COLLECTION_OPS.has(expr.member) && expr.args[0]?.kind === "lambda")
  ) {
    return renderCollectionOp(expr, ctx);
  }
  // API binding shape: `<ApiHandle>.<Agg>.<op>(args)`.
  // We detect it structurally: receiver is a `member` whose receiver is
  // a `ref` to one of the UI's api parameters.
  const api = detectApiCall(expr, ctx);
  if (api) return renderApiCall(api, ctx);
  const recv = renderExpr(expr.receiver, ctx);
  const args = expr.args.map((a) => renderExpr(a, ctx));
  // Catalogued scalar intrinsic (src/util/intrinsics.ts) — `s.toUpper()` etc.
  // Without this arm the walker fell through to the verbatim `recv.member(args)`
  // below, snake-cased into a call Elixir has no such method for
  // (`s.to_upper()` — not a String function) — a compile error, exactly the
  // gap `renderMethodCall` in the domain-side `render-expr.ts` already closed
  // for op/derived/invariant bodies via the SAME table, reused here so a page
  // body and a domain expression agree on what `s.replace(a, b)` means.
  if (expr.receiverType.kind === "primitive" && intrinsicFor(expr.receiverType.name, expr.member)) {
    const snippet = ELIXIR_INTRINSIC_RENDERERS[intrinsicKey(expr.receiverType.name, expr.member)];
    if (snippet) return snippet(recv, args);
  }
  // Generic chained call — emit Elixir-style.
  return `${recv}.${snake(expr.member)}(${args.join(", ")})`;
}

/** A call to a user-defined `component` → a fully-qualified HEEx
 *  function-component invocation.  Positional args bind to the
 *  component's declared params in order; named args bind by name.
 *  Values render in template position (refs become `@assign`). */
function renderUserComponent(
  expr: Extract<ExprIR, { kind: "call" }>,
  comp: ComponentIR,
  ctx: WalkContext,
): string {
  ctx.usedComponents.add(comp.name);
  ctx.componentUses.set(comp.name, (ctx.componentUses.get(comp.name) ?? 0) + 1);
  const attrs: string[] = [];
  let pos = 0;
  for (let i = 0; i < expr.args.length; i++) {
    const argName = expr.argNames?.[i];
    const paramName = argName ?? comp.params[pos++]?.name;
    if (!paramName) continue;
    const value = renderExpr(expr.args[i]!, { ...ctx, position: "template" });
    attrs.push(`${snake(paramName)}={${value}}`);
  }
  // Extern component (extern-component-escape-hatch.md) → a hand-written
  // Phoenix LiveComponent the user owns, embedded via the built-in
  // `<.live_component>`.  The MODULE reference is the binding — Elixir's native
  // module system, no import/alias needed (the framework-mismatch analogue of
  // the JSX frontends' `tsc` fail-fast: a wrong module fails to compile).
  // `id` is required by `live_component`; the snake component name is stable.
  if (comp.extern) {
    const mod = externModuleFromPath(comp.externPath ?? "");
    const rest = attrs.length > 0 ? ` ${attrs.join(" ")}` : "";
    return `<.live_component module={${mod}} id="${snake(comp.name)}"${rest} />`;
  }
  // Lifted state — the callee's own `state { … }` plus that of every component
  // it renders, threaded down from the host LiveView's assigns under the same
  // namespaced name at every level (see `hostStateAssign`).  Rendered in
  // template position because a call site always sits inside a `~H` body.
  for (const { assign } of liftedStateAttrs(comp, ctx.ui)) {
    attrs.push(`${assign}={@${assign}}`);
  }
  const tag = `${ctx.appModule}Web.Components.UiComponents.${snake(comp.name)}`;
  return attrs.length > 0 ? `<${tag} ${attrs.join(" ")} />` : `<${tag} />`;
}

/** Derive the Elixir module reference for an `extern` component from its
 *  `from "<path>"` clause.  Elixir binds by MODULE, not by file path, so the
 *  path segments (split on `/` or `.`) are PascalCased and joined with `.` —
 *  e.g. `"widgets/order-chart"` → `Widgets.OrderChart`.  The user writes a
 *  `Phoenix.LiveComponent` under exactly that module. */
function externModuleFromPath(path: string): string {
  const pascalSeg = (seg: string): string =>
    seg
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((w) => upperFirst(w))
      .join("");
  return path
    .replace(/^\.?\//, "")
    .split(/[/.]/)
    .filter(Boolean)
    .map(pascalSeg)
    .join(".");
}

/** `Action(<instance>.<operation>, then?)` → a `<.button phx-click=…>`
 *  whose event loads the instance by id and invokes the operation.
 *  The operation is referenced through an in-scope aggregate instance
 *  (a component param or a QueryView record), resolved via
 *  `instanceTypes`.  The handler is recorded as an `ActionBinding` and
 *  hoisted to the host page's LiveView by the emitter. */
export function renderAction(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const opRef = expr.args.find((_, i) => !expr.argNames?.[i]);
  if (opRef?.kind !== "member" || opRef.receiver.kind !== "ref") {
    return `<!-- Action: expected <instance>.<operation> -->`;
  }
  const instanceName = opRef.receiver.name;
  const opName = opRef.member;
  const aggName = ctx.instanceTypes?.get(instanceName);
  if (!aggName) {
    return `<!-- Action(${instanceName}.${opName}): '${instanceName}' is not an in-scope aggregate instance -->`;
  }
  const agg = ctx.aggregatesByName.get(aggName);
  const op = agg?.operations.find((o) => o.name === opName && o.visibility === "public");
  if (!op) {
    return `<!-- Action(${instanceName}.${opName}): no public operation '${opName}' on ${aggName} -->`;
  }
  const eventName = `${snake(opName)}_${snake(aggName)}`;
  const idExpr = `${renderExpr(opRef.receiver, { ...ctx, position: "template" })}.id`;
  // `then: navigate(<Page>)` → push_navigate route (snake convention,
  // matching renderNavigate / the scaffold router).
  let thenRoute: string | undefined;
  for (let i = 0; i < expr.args.length; i++) {
    if (expr.argNames?.[i] !== "then") continue;
    const eff = expr.args[i]!;
    if (eff.kind === "call" && eff.name === "navigate") {
      const target = eff.args[0];
      if (target && target.kind === "ref") thenRoute = `/${snake(target.name)}`;
    }
  }
  if (!ctx.actionBindings.some((b) => b.eventName === eventName)) {
    ctx.actionBindings.push({
      agg: aggName,
      op: snake(opName),
      opHuman: humanize(opName),
      eventName,
      thenRoute,
    });
  }
  const button = `<.button phx-click="${eventName}" phx-value-id={${idExpr}}>${humanize(opName)}</.button>`;
  return gateActionButton(button, op, ctx);
}

/** Wrap an `Action` `<.button>` in a server-side currentUser gate when the
 *  host deployable has auth AND every `requires` predicate on the operation
 *  is currentUser-only — the LiveView/HEEx mirror of the JSX frontends'
 *  action-button gating (`emitAction` in _walker/primitives/controls.ts).
 *
 *  Gating signal: `ctx.authEnabled` (the deployable runs `auth: required`,
 *  so `LiveAuth.on_mount` assigns `@current_user`).  Without auth there is
 *  no `@current_user` to read, so the button is left ungated and the output
 *  stays byte-identical.  An op with no `requires`, or any predicate that
 *  touches `this.<field>` / params (not currentUser-only — `tryRenderGate`
 *  returns null), is also left ungated; the operation still enforces the
 *  gate server-side regardless (defence-in-depth). */
function gateActionButton(
  button: string,
  op: import("../../ir/types/loom-ir.js").OperationIR,
  ctx: WalkContext,
): string {
  if (!ctx.authEnabled) return button;
  const gates = op.statements.filter((s) => s.kind === "requires").map((s) => s.expr);
  if (gates.length === 0) return button;
  // Classify with the JS gate-expr (currentUser-only ⇒ non-null); gate only
  // when EVERY predicate is currentUser-only.  The rendered Elixir gate is
  // produced by `renderExpr` in template scope (`@current_user.…`), NOT by
  // the JS renderer — `tryRenderGate` is used purely as the classifier.
  if (!gates.every((g) => tryRenderGate(g, "currentUser") !== null)) return button;
  const tmplCtx: WalkContext = { ...ctx, position: "template" };
  // Multiple `requires` clauses combine with Elixir's `and` (the JSX mirror
  // uses `&&`); `renderExpr` already emits `@current_user.…` in template
  // scope, so the parenthesised predicates compose directly inside `if`.
  const gate = gates.map((g) => `(${renderExpr(g, tmplCtx)})`).join(" and ");
  return `<%= if (${gate}) do %>${button}<% end %>`;
}

function renderCall(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  // Store-action call — `Cart.add(sku)` / `Cart.clear()` (Stage 5).  Resolved
  // at lowering into a `call` carrying `callKind: "store-action"` +
  // `storeAction: { store, action }`.  Renders to an `update/3` over the
  // store's per-page assign applying the pure store-module fn.  Always a
  // handler-position effect (a `handle_event` body); record the use so the
  // emitter seeds the assign + alias.  (A page action body reaches this via
  // the `renderStmt` `call` arm, which pipes the result; an expr-position call
  // — rare — returns the bare `update(...)` so an enclosing pipe can consume
  // it.)
  if (expr.callKind === "store-action" && expr.storeAction) {
    ctx.usedStores.add(expr.storeAction.store);
    const args = expr.args.map((a) => renderExpr(a, { ...ctx, position: "handler" })).join(", ");
    return renderHeexStoreActionCall(expr.storeAction.store, expr.storeAction.action, args);
  }
  // navigate(<Page>, { … }) — Loom's cross-page navigation primitive.
  if (expr.name === "navigate") {
    return renderNavigate(expr.args, ctx);
  }
  // toast(<msg>) — flash message.
  if (expr.name === "toast") {
    return renderToast(expr, ctx);
  }
  // A VALUE-OBJECT construction (`Money(9.99, "USD")`) — checked BEFORE the
  // primitive-name registry below, since a domain VO can share a name with a
  // built-in walker primitive (`Money` is also a display primitive,
  // `renderMoney`).  Without this the registry lookup won though first and
  // rendered the primitive's MARKUP — `<span class="money">…</span>` — in
  // what was meant to be a value position, and a following `.currency`
  // member access then got appended as literal text after the closing
  // `</span>`: `<%= <span class="money">…</span>.currency %>`, invalid HEEx.
  // On the wire a value object is a plain record: mirror the domain-side
  // `value-object-ctor` rendering (render-expr.ts) — a plain Elixir map
  // (vanilla stores VOs as JSON, no `%Ctx.VO{}` struct) — backfilling
  // positional args from the VO's declared field order exactly like the
  // shared JSX/Feliz/Flutter walker's `declaredValueObject` already does for
  // the same name collision (walker-core.ts).
  const vo = ctx.valueObjectsByName.get(expr.name);
  if (vo) {
    let positional = 0;
    const fields = expr.args
      .map((a, i) => {
        const name = expr.argNames?.[i] ?? vo.fields[positional++]?.name;
        return name ? `${snake(name)}: ${renderExpr(a, ctx)}` : undefined;
      })
      .filter((f): f is string => f !== undefined);
    return `%{${fields.join(", ")}}`;
  }
  // Closed-primitive library dispatch — the typed registry at
  // src/generator/_walker/registry.ts holds the renderer for every
  // primitive the HEEx target supports (a subset of what TSX
  // supports; see the registry for the matrix).  Names registered
  // without a `heex` entry fall through to the user-component /
  // helper paths and ultimately to a visible HEEx comment so the
  // gap is visible in generated output.
  const def = WALKER_PRIMITIVES[expr.name];
  if (def?.heex) return def.heex(expr, ctx);
  // User-defined `component` invocation → a remote HEEx function
  // component (`<MyAppWeb.Components.UiComponents.order_panel … />`).
  const userComp = ctx.ui.components.find((c) => c.name === expr.name);
  if (userComp) return renderUserComponent(expr, userComp, ctx);
  // Extern frontend function (`function f(…): T extern from "…"`,
  // extern-function-hook-escape-hatch.md) → a FULLY-QUALIFIED call into the
  // user's hand-written Elixir module (derived from the `from` path), so no
  // import wiring is needed — Elixir resolves a fully-qualified call without an
  // `import` (the function twin of the extern-component `<.live_component
  // module={…}>` binding).  A missing module fails `mix compile` — the
  // fail-fast, matching the JSX frontends' `tsc` conformance-shim check.
  const externFn = ctx.ui.functions?.find((f) => f.name === expr.name);
  if (externFn) {
    const mod = externModuleFromPath(externFn.externPath);
    const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
    return `${mod}.${snake(expr.name)}(${args})`;
  }
  // Registered primitive that the HEEx target doesn't support yet — emit a
  // comment so the divergence shows up in the generated template instead of
  // silently producing wrong markup.  The EEx-NATIVE form (`<%!-- … --%>`), not
  // an HTML comment: an HTML comment is markup, and a sub-primitive reaching
  // here through an expression position would be wrapped as `<%= <!-- … --> %>`
  // — a syntax error `mix compile` rejects.  `<%!-- … --%>` is inert in both
  // positions (`isHEExCall` also keeps every registered primitive in markup
  // position, so the wrap no longer happens either).
  if (def) {
    return `<%!-- ${expr.name}: not supported by Phoenix LiveView target --%>`;
  }
  // Helper function call.
  if (expr.callKind === "function" || expr.callKind === "free") {
    const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
    return `${snake(expr.name)}(${args})`;
  }
  const args = expr.args.map((a) => renderExpr(a, ctx)).join(", ");
  return `${snake(expr.name)}(${args})`;
}

function renderBinary(expr: Extract<ExprIR, { kind: "binary" }>, ctx: WalkContext): string {
  const l = renderExpr(expr.left, ctx);
  const r = renderExpr(expr.right, ctx);
  // String concatenation: Elixir uses `<>`.  Decide on the IR TYPE stamps the
  // way the domain renderer does (`render-expr.ts` `elixirOp(op, leftIsString)`)
  // — `who + other` between two string state cells carries no string LITERAL
  // on either side, and `+` on two binaries raises `ArithmeticError` at render.
  // The literal probe stays as the fallback for synthetic binary nodes (the
  // walker-primitive expander and friends leave the type stamps undefined).
  if (expr.op === "+" && isStringConcat(expr)) {
    return `${l} <> ${r}`;
  }
  // A5 temporal — datetime ± duration / datetime − datetime in a page body.
  // Mirrors the domain renderer's in-memory arms (`render-expr.ts`,
  // `renderTemporalBinary`): ms `DateTime.add/diff`.
  if (expr.op === "+" || expr.op === "-") {
    const temporal = renderTemporalBinary(l, r, expr);
    if (temporal !== null) return temporal;
  }
  switch (expr.op) {
    case "&&":
      return `${l} and ${r}`;
    case "||":
      return `${l} or ${r}`;
    default:
      return `${l} ${expr.op} ${r}`;
  }
}

function isStringLit(e: ExprIR): boolean {
  return e.kind === "literal" && e.lit === "string";
}

function isStringPrim(t: TypeIR | undefined): boolean {
  return t?.kind === "primitive" && t.name === "string";
}

/** A `+` binary that is really Elixir string CONCATENATION (`<>`).  The IR type
 *  stamps (`leftType` / `rightType` / `resultType`, populated during lowering)
 *  are authoritative; the string-literal probe is only the fallback for
 *  synthetic nodes that carry no stamps. */
function isStringConcat(expr: Extract<ExprIR, { kind: "binary" }>): boolean {
  return (
    isStringPrim(expr.leftType) ||
    isStringPrim(expr.rightType) ||
    isStringPrim(expr.resultType) ||
    isStringLit(expr.left) ||
    isStringLit(expr.right)
  );
}

// A5 temporal (page bodies) — the same in-memory representation as the
// domain renderer (`render-expr.ts`): an absolute duration is plain integer
// MILLISECONDS.

function renderDuration(unit: DurationUnit, amount: string): string {
  switch (unit) {
    case "days":
      return `((${amount}) * ${DURATION_UNIT_MS.days})`;
    case "hours":
      return `((${amount}) * ${DURATION_UNIT_MS.hours})`;
    case "minutes":
      return `((${amount}) * ${DURATION_UNIT_MS.minutes})`;
  }
}

/** The datetime-involving `+`/`-` arms, or null to fall through to native
 *  operator rendering — dispatch off the lowering's `leftType`/`resultType`
 *  stamps, exactly like the domain renderer's `renderTemporalBinary`. */
function renderTemporalBinary(
  l: string,
  r: string,
  e: Extract<ExprIR, { kind: "binary" }>,
): string | null {
  if (e.op !== "+" && e.op !== "-") return null;
  const prim = (t: { kind: string; name?: string } | undefined): string | null =>
    t?.kind === "primitive" ? (t.name ?? null) : null;
  const lt = prim(e.leftType);
  const rt = prim(e.resultType);
  if (lt === "datetime") {
    if (e.op === "-" && rt === "duration") return `DateTime.diff(${l}, ${r}, :millisecond)`;
    if (rt === "datetime") {
      return e.op === "+"
        ? `DateTime.add(${l}, ${r}, :millisecond)`
        : `DateTime.add(${l}, -(${r}), :millisecond)`;
    }
    return null;
  }
  if (lt === "duration" && e.op === "+" && rt === "datetime") {
    return `DateTime.add(${r}, ${l}, :millisecond)`;
  }
  return null;
}

function renderMatch(expr: Extract<ExprIR, { kind: "match" }>, ctx: WalkContext): string {
  // `match { p => v; … else => f }` → Elixir `cond do … end`.
  // Delegates the bare `cond do … end` shape to `heexTarget.renderMatch`
  // (cross-framework contract — see src/generator/_walker/target.ts).
  // The `<%= … %>` template-position wrap stays here because it's
  // walker-local (HEEx walker tracks `ctx.position`; the target
  // contract is position-agnostic for match).
  const arms = expr.arms.map((a) => ({
    predicate: renderExpr(a.cond, ctx),
    value: renderExpr(a.value, ctx),
  }));
  const elseArm = expr.otherwise ? renderExpr(expr.otherwise, ctx) : undefined;
  const cond = heexTarget.renderMatch(arms, elseArm);
  return ctx.position === "template" ? `<%= ${cond} %>` : cond;
}

function renderObjectLiteral(expr: Extract<ExprIR, { kind: "object" }>, ctx: WalkContext): string {
  const fields = expr.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ");
  return `%{${fields}}`;
}

/** `new Part { … }` in a page body → an Elixir struct literal, mirroring
 *  the domain emitter (`render-expr.ts::renderNew`): a part is an Ecto
 *  `embedded_schema` struct, addressed as `%<Ctx>.<Part>{field: value, …}`.
 *  The context module is
 *  resolved from the part's owning aggregate via `ctx.partContextModule`;
 *  when the orchestrator hasn't threaded that map (or the part is unknown)
 *  it falls back to `ctx.appModule` so the output is still valid Elixir. */
function renderNew(expr: Extract<ExprIR, { kind: "new" }>, ctx: WalkContext): string {
  const fields = expr.fields.map((f) => `${snake(f.name)}: ${renderExpr(f.value, ctx)}`).join(", ");
  const ctxModule = ctx.partContextModule.get(expr.partName) ?? ctx.appModule;
  return `%${ctxModule}.${upperFirst(expr.partName)}{${fields}}`;
}

// ---------------------------------------------------------------------------
// Collection operations.
// ---------------------------------------------------------------------------

function renderCollectionOp(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): string {
  const recv = renderExpr(expr.receiver, ctx);
  const arg0 = expr.args[0];
  switch (expr.member) {
    case "count":
      return `Enum.count(${recv})`;
    case "sum":
      if (arg0?.kind === "lambda" && arg0.body) {
        const param = arg0.param;
        const body = renderExpr(arg0.body, { ...ctx, position: ctx.position });
        return `Enum.reduce(${recv}, 0, fn ${snake(param)}, acc -> acc + ${body} end)`;
      }
      return `Enum.sum(${recv})`;
    case "where":
    case "filter":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.filter(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return recv;
    case "map":
    case "select":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.map(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return recv;
    case "any":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.any?(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return `(${recv} != [])`;
    case "all":
      if (arg0?.kind === "lambda" && arg0.body) {
        return `Enum.all?(${recv}, fn ${snake(arg0.param)} -> ${renderExpr(arg0.body, ctx)} end)`;
      }
      return `true`;
    case "contains":
      if (arg0) {
        return `Enum.member?(${recv}, ${renderExpr(arg0, ctx)})`;
      }
      return `false`;
    default:
      return `${recv}.${snake(expr.member)}(${expr.args.map((a) => renderExpr(a, ctx)).join(", ")})`;
  }
}

// ---------------------------------------------------------------------------
// API binding lowering.
// ---------------------------------------------------------------------------

interface ApiCallSite {
  apiHandle: string;
  aggregateName: string;
  operation: string;
  args: ExprIR[];
}

function detectApiCall(
  expr: Extract<ExprIR, { kind: "method-call" }>,
  ctx: WalkContext,
): ApiCallSite | null {
  // Shape: <ApiHandle>.<Agg>.<op>(args)  →
  // method-call { receiver: member { receiver: ref, member: <Agg> }, member: <op> }
  if (
    expr.receiver.kind === "member" &&
    expr.receiver.receiver.kind === "ref" &&
    isApiHandle(expr.receiver.receiver.name, ctx)
  ) {
    return {
      apiHandle: expr.receiver.receiver.name,
      aggregateName: expr.receiver.member,
      operation: expr.member,
      args: expr.args,
    };
  }
  return null;
}

function isApiHandle(name: string, ctx: WalkContext): boolean {
  return ctx.ui.apiParams.some((p) => p.name === name);
}

function renderApiCall(call: ApiCallSite, ctx: WalkContext): string {
  // The resource lives in the Phoenix context module of the aggregate's
  // bounded context — `<App>.<Ctx>` — which `contextModuleByAggName`
  // already resolves (the same map every other Elixir emit site routes
  // through).  The api *handle* is a UI-local alias (`UiApiParamIR.name`),
  // NOT the context: routing on it only worked because acme.ddd happens to
  // name the alias `Sales`, equal to its context.  Route on the aggregate's
  // context instead, so a handle aliased to anything else stays correct.
  //
  // The bare `<fn>(<args>)` shape — including the op→fn naming convention
  // and the crude pluralisation — is delegated to `heexTarget.renderApiCall`
  // (cross-framework contract — see src/generator/_walker/target.ts).
  const ctxModule = ctx.contextModuleByAggName.get(call.aggregateName) ?? ctx.appModule;
  const renderedArgs = call.args.map((a) => renderExpr(a, ctx)).join(", ");
  const bare = heexTarget.renderApiCall(
    {
      apiHandle: call.apiHandle,
      aggregateName: call.aggregateName,
      operation: call.operation,
      // ApiCallSite.kind isn't consulted by heexTarget.renderApiCall —
      // the bare-fn naming is op-driven, not query-vs-mutation.  Pass
      // a structural placeholder.
      kind: "query",
      args: call.args,
    },
    renderedArgs,
  );
  return `${ctxModule}.${bare}`;
}

// ---------------------------------------------------------------------------
// Navigation + toast.
// ---------------------------------------------------------------------------

function renderNavigate(navArgs: readonly ExprIR[], ctx: WalkContext): string {
  // navigate(<Page>, { customerId: x }) — first arg is the page
  // reference, second is the params object.  The router uses
  // `live "<route>", <Page>Live`; lowers to `push_navigate(socket,
  // to: ~p"<route>")` with param substitution via Phoenix's `~p`
  // sigil.
  //
  // Walker resolves the page → route + params object → arg list,
  // then delegates the `push_navigate(...)` shape to
  // `heexTarget.renderNavigate` (cross-framework contract — see
  // src/generator/_walker/target.ts).  The `args[0].kind !== "ref"`
  // fallback stays walker-local because it's a parse-time invariant
  // failure, not a per-target rendering decision.
  const target = navArgs[0];
  const params = navArgs[1];
  if (target?.kind !== "ref") {
    return `push_navigate(socket, to: "/")`;
  }
  const routePath = `/${snake(target.name)}`;
  const args =
    params && params.kind === "object"
      ? params.fields.map((f) => ({
          name: f.name,
          value: renderExpr(f.value, { ...ctx, position: "handler" }),
        }))
      : [];
  return heexTarget.renderNavigate(routePath, args);
}

function renderToast(expr: Extract<ExprIR, { kind: "call" }>, ctx: WalkContext): string {
  const msg = expr.args[0] ? renderExpr(expr.args[0], ctx) : `""`;
  return `put_flash(socket, :info, ${msg})`;
}

export interface PrimitiveSpec {
  /** HEEx component tag, e.g. ".heading", "div" (for raw layout), or
   *  ".button" — driven by the coreComponents pack conventions. */
  tag: string;
  /** Attribute keys that take literal values rendered as static
   *  strings (vs JS-expression braces).  Empty by default. */
  staticAttrs?: string[];
  /** Whether the primitive renders children — if so, the call's
   *  argument that's an array of children expressions is rendered
   *  as nested HEEx. */
  takesChildren?: boolean;
  /** Static attributes emitted on the tag (e.g. an a11y `role="toolbar"` /
   *  `aria-label="Actions"` the primitive's contract requires).
   *
   *  They are DEFAULTS, not overrides: an entry whose attribute name a derived
   *  named attribute already emitted is dropped.  `Toolbar`'s contract is
   *  `{role:"toolbar", needsName:true}` with "Actions" as the fallback name, so
   *  an author's `label:` has to win — emitting both would put two `aria-label`
   *  attributes on one tag, and the contract default would silently outrank the
   *  authored (and translated) name. */
  extraAttrs?: string[];
  /** When set, a `label:` named arg is emitted as an `aria-label` attribute
   *  (the accessible name) rather than a literal `label=` attribute.  Used by
   *  the primitives whose visible text can't serve as the name: the command
   *  `Button` (an unhelpful glyph) and the `Toolbar` (a group with no text of
   *  its own).  Without it the author's `label:` falls through the generic
   *  named-attr branch and lands as a bogus `label=` attribute on a `<div>`. */
  labelAsAriaLabel?: boolean;
  /** Tailwind utility classes emitted as this tag's `class` attribute — the
   *  LAYOUT of a layout primitive (`Stack` = a column flexbox, `Grid` = a CSS
   *  grid, …).  Both shipping HEEx packs build Tailwind through the same assets
   *  pipeline and scan the emitted `.*ex` sources, so a literal class string
   *  here survives the production purge on either pack.
   *
   *  Layout utilities are design-NEUTRAL (daisyUI adds a COMPONENT vocabulary —
   *  `btn`, `card`, `alert` — not a layout one), which is why they live in the
   *  walker while the card SURFACE goes through the pack's `<.card>` function
   *  component.  See `renderCard`. */
  baseClass?: string;
  /** Named args that legitimately become attributes on this tag — everything
   *  else is DROPPED rather than spliced through as a bare HTML attribute.
   *
   *  A closed primitive's named args are its own vocabulary (`Grid`'s `cols:`,
   *  `Container`'s `size:`, `Card`'s `variant:`), NOT markup attributes: the
   *  generic fall-through emitted `cols={[3, 2, 1]}` (a LIST handed to
   *  Phoenix's attribute escaper at RENDER time — see `isAttrRenderable`),
   *  `size="lg"` on a `<div>` (invalid), and `variant="primary"` on
   *  `<.button>` (an undeclared
   *  attr on a function component ⇒ a `mix compile --warnings-as-errors`
   *  failure).  Consumed-or-dropped is the only safe default; a knob that
   *  SHOULD reach the markup is listed here, deliberately. */
  passThroughAttrs?: readonly string[];
  /** Wrap each rendered child in this tag (`Grid` → one `<div>` grid item per
   *  child).  Mirrors the JSX packs' per-column wrapper: without it a child
   *  that renders several roots (a `Table` plus its pager) would occupy two
   *  grid cells instead of one. */
  childWrapper?: string;
}

/** The attribute NAME of a rendered HEEx attribute fragment (`aria-label={…}` →
 *  `aria-label`).  Used to let a derived attribute suppress the same-named
 *  contract default in {@link PrimitiveSpec.extraAttrs}. */
function attrName(fragment: string): string {
  const eq = fragment.indexOf("=");
  return eq === -1 ? fragment : fragment.slice(0, eq);
}

/** The i18n catalog ROLE of a primitive's positional slot, from the shared
 *  `USER_VISIBLE_SLOTS` table — undefined when that position holds no
 *  user-visible text.  Reading the same table the extraction pass reads is what
 *  keeps the emitted key equal to the catalog key (M-T1.11). */
export function positionalRole(primitive: string, index: number): string | undefined {
  return USER_VISIBLE_SLOTS[primitive]?.find((s) => s.kind === "positional" && s.index === index)
    ?.role;
}

export function renderPrimitive(
  spec: PrimitiveSpec,
  expr: Extract<ExprIR, { kind: "call" }>,
  ctx: WalkContext,
): string {
  // Named args (`Stack(children: […])`, `Heading("title", level: 2)`)
  // become HEEx attributes; positional args land as children for
  // takesChildren=true, or as the primary value for tag-specific
  // primitives (Heading's text, Badge's label).
  const namedAttrs: string[] = [];
  const childrenExprs: ExprIR[] = [];
  const positional: ExprIR[] = [];

  for (let i = 0; i < expr.args.length; i++) {
    const name = expr.argNames?.[i];
    const arg = expr.args[i]!;
    if (name) {
      if (name === "children" && arg.kind === "object") {
        // Unlikely shape; skip.
      } else if (name === "children") {
        // Children as an array.  Unwrap if literal `[a,b,c]` — but the
        // expression IR doesn't have an explicit array literal kind,
        // so children typically arrive as a single sub-expression.
        childrenExprs.push(arg);
      } else if (name === "on" || name === "onClick" || name === "onSubmit" || name === "then") {
        // Inline lambda → handle_event hoist; a bare named-action reference
        // (`onClick: bump`) is an `action-ref` ExprIR that renders to the
        // declared event name (its `handle_event` clause is hoisted from
        // `page.actions` at the top of `walkBodyToHeex`).
        const eventName =
          arg.kind === "action-ref" ? renderExpr(arg, ctx) : hoistLambdaToHandler(arg, ctx);
        const phxAttr = name === "onSubmit" ? "phx-submit" : "phx-click";
        namedAttrs.push(`${phxAttr}="${eventName}"`);
      } else if (name === "testid") {
        // The DSL `testid:` arg maps to the HTML `data-testid` attribute
        // (what Playwright / lvtest assertions look for).  Without this
        // special-case the generic else-branch below would emit a bare
        // `testid=` attribute which no test harness recognises.
        const value = renderAttrValue(arg, ctx, false);
        if (value !== undefined) namedAttrs.push(`data-testid=${value}`);
      } else if (name === "label" && spec.labelAsAriaLabel) {
        // A command button's / toolbar's `label:` is its accessible name
        // (aria-label), not a literal `label=` attribute — and a user-visible
        // slot, so it rides the translation runtime under i18n (M-T1.11)
        // instead of shipping the name in English at every locale.  An
        // INTERPOLATED name translates too: `localizedHeexAttr` funnels both
        // shapes, so the ICU branch is reached here rather than falling through
        // to the raw `<>` concat `loom.user-visible-concat` bans in source.
        const value =
          localizedHeexAttr(arg, ctx, namedRole(expr.name, "label")) ??
          renderAttrValue(arg, ctx, true);
        if (value !== undefined) namedAttrs.push(`aria-label=${value}`);
      } else if (spec.passThroughAttrs?.includes(name)) {
        const value = renderAttrValue(arg, ctx, spec.staticAttrs?.includes(name) ?? false);
        if (value !== undefined) namedAttrs.push(`${snake(name)}=${value}`);
      }
      // Every other named arg is DROPPED — see `PrimitiveSpec.passThroughAttrs`.
      // A closed primitive's knobs (`cols:`, `size:`, `variant:`, `gap:`) are
      // consumed by its renderer (folded into `baseClass` / a pack component
      // attribute) or deliberately ignored the way the JSX packs ignore the
      // knobs they don't map; NONE of them may reach the markup as a bare
      // attribute.
    } else {
      positional.push(arg);
    }
  }

  // `style: { ... }` escape hatch — see styleIrToHeex.  Pushed first
  // so it lands before any other attributes for predictable output.
  const styleHeexAttr = styleIrToHeex(expr);
  if (styleHeexAttr) namedAttrs.unshift(styleHeexAttr);

  // Layout classes lead the tag (`<div class="flex flex-col gap-4" …>`), the
  // way the JSX packs' templates spell it — so unshifted LAST.
  if (spec.baseClass) namedAttrs.unshift(`class="${escapeHeexAttr(spec.baseClass)}"`);

  // Contract-required static a11y attributes (e.g. Toolbar's role/name), as
  // DEFAULTS — an entry whose attribute a derived one already emitted is
  // dropped, so an authored `label:` beats the contract's fallback name instead
  // of the tag carrying two `aria-label`s.
  if (spec.extraAttrs) {
    const emitted = new Set(namedAttrs.map(attrName));
    namedAttrs.push(...spec.extraAttrs.filter((a) => !emitted.has(attrName(a))));
  }

  // Other primitives — render children (if any).  A POSITIONAL child may be a
  // user-visible text slot (`Text`/`Bold`/`Badge`/`Button`/… index 0), so it is
  // rendered with its catalog role; `childrenExprs` are nested markup and never
  // carry one.  The role table is the shared `USER_VISIBLE_SLOTS`, so the key
  // the walker emits equals the key the extraction pass put in the catalog.
  const renderedChildren = [
    ...childrenExprs.map((c) => renderChild(c, ctx)),
    ...(spec.takesChildren
      ? positional.map((c, i) => renderChild(c, ctx, positionalRole(expr.name, i)))
      : []),
  ];
  const childrenHeex = (
    spec.childWrapper
      ? renderedChildren.map(
          (c) => `<${spec.childWrapper}>\n${indent(c, 2)}\n</${spec.childWrapper}>`,
        )
      : renderedChildren
  ).join("\n");
  const attrs = namedAttrs.length > 0 ? " " + namedAttrs.join(" ") : "";
  if (childrenHeex.length === 0) {
    return spec.tag.startsWith(".") ? `<${spec.tag}${attrs} />` : `<${spec.tag}${attrs} />`;
  }
  return `<${spec.tag}${attrs}>\n${indent(childrenHeex, 2)}\n</${spec.tag}>`;
}

/** Build a `style="..."` HEEx attribute from a call's `style` IR.
 *  Returns undefined when the call carries no style field.  Keys are
 *  emitted verbatim (kebab-case is the HTML CSS spelling).  String-
 *  literal values land as raw CSS values; non-literal values are
 *  passed through as Elixir interpolation (`<%= … %>`) — but for v1
 *  we keep the common path (string literals) static-safe.  Special
 *  characters are HTML-escaped so the attribute stays well-formed. */
function styleIrToHeex(expr: Extract<ExprIR, { kind: "call" }>): string | undefined {
  if (!expr.style || expr.style.entries.length === 0) return undefined;
  const parts = expr.style.entries.map(({ key, value }) => {
    let v: string;
    if (value.kind === "literal" && value.lit === "string") v = value.value;
    else if (value.kind === "ref") v = `<%= ${value.name} %>`;
    else v = "";
    return `${key}: ${v}`;
  });
  const css = parts.join("; ").replace(/"/g, "&quot;");
  return `style="${css}"`;
}

/** Returns true for calls that produce raw HEEx markup (not Elixir
 *  expressions) — these should NOT be wrapped in `<%= %>`.  Consults
 *  the typed registry (ANY registered walker primitive renders in markup
 *  position) so new primitives don't need a second list
 *  edit, AND the ui's user `component`s — a `component` invocation
 *  renders to a HEEx function-component tag
 *  (`<…UiComponents.order_panel … />`), which is markup, so wrapping it
 *  in `<%= %>` (e.g. inside a QueryView `data:` `cond` arm) produces
 *  invalid HEEx.
 *
 *  Membership is keyed on the primitive being REGISTERED, not on it having a
 *  `heex` renderer: a registered primitive with no HEEx renderer falls through
 *  to the unsupported-primitive comment, which is markup too — gating on
 *  `.heex !== undefined` classified exactly that case as an expression and
 *  wrapped the comment, emitting uncompilable EEx. */
function isHEExCall(name: string, ctx: WalkContext): boolean {
  if (WALKER_PRIMITIVES[name] !== undefined) return true;
  return ctx.ui.components.some((c) => c.name === name);
}

/** Escape a `.ddd`-sourced literal string sitting in HEEx TEXT position.
 *  The HEEx tokenizer treats `<` as a tag opener and `<%= … %>` / `<% … %>`
 *  as embedded Elixir, so an unescaped literal like `"<b>"` or `"<%= evil %>"`
 *  breaks the template or executes code.  Entity-escaping `&` / `<` / `>`
 *  neutralizes both (a `&lt;%= %>` is inert text).  This is the single funnel
 *  every text-position emit site shares (renderChild / renderInTemplate + the
 *  per-primitive label sites), so the escaping can't drift one renderer at a
 *  time.  Mirrors `heexTarget.escapeText`, which delegates here. */
export function escapeHeexText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Escape a `.ddd`-sourced literal string used as a quoted HEEx attribute
 *  value (`attr="…"`) — the funnel that keeps literal `attrValue` /
 *  `renderAttrValue` (and the `<:col label=…>` header) well-formed.
 *
 *  `"` and `&` are the two that BREAK the template (`"` closes the attribute
 *  mid-value — `Column { "Na\"me" }` used to emit `label="Na"me"`, which
 *  `mix compile` rejects with "missing space before attribute"; `&` opens an
 *  entity).  `<`/`>` are escaped too so the emitted attribute matches what
 *  `Phoenix.HTML.html_escape/1` would produce for the same string. */
export function escapeHeexAttr(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** A literal user-visible slot, translated through the generated Gettext
 *  backend when the body opted into i18n (M-T1.11).
 *
 *  `pgettext(<loom key>, <English>)` — the CONTEXT is Loom's content-hashed
 *  catalog key (identical to `.loom/messages.en.json` and to what the other
 *  five frontends emit), the msgid is the source-language default, so gettext's
 *  own "empty translation ⇒ render the msgid" rule gives the same fallback the
 *  JS `messages[key] ?? default` shim has.  Wrapped in `<%= … %>`: it is a
 *  function call in HEEx text position, not static markup.
 *
 *  An INTERPOLATED slot (a lowered backtick template) rides the SAME call with
 *  the ICU formatting step layered over it — see {@link heexTranslateCall}.
 *
 *  Returns undefined when i18n is off, the slot has no role, or the value is
 *  neither a plain literal nor an interpolation — each of which keeps the
 *  pre-i18n raw path. */
function localizedHeex(
  arg: ExprIR,
  ctx: WalkContext,
  role: string | undefined,
): string | undefined {
  const call = heexTranslateCall(arg, ctx, role);
  return call === undefined ? undefined : `<%= ${call} %>`;
}

/** The bare translation CALL for a user-visible slot, with no positional
 *  wrapping — the shared half of {@link localizedHeex} (text position, `<%= …
 *  %>`) and {@link localizedHeexAttr} (attribute position, `{…}`).  Undefined
 *  on every path that keeps the pre-i18n raw output.
 *
 *  Two shapes, one catalog key:
 *
 *   - a plain literal → `pgettext(<key>, <English>)`.  The CONTEXT is Loom's
 *     content-hashed key (identical to `.loom/messages.en.json` and to what the
 *     other five frontends emit), the msgid is the source-language default, so
 *     gettext's own "empty translation ⇒ render the msgid" rule gives the same
 *     fallback the JS `messages[key] ?? default` shim has;
 *   - an INTERPOLATION → the same `pgettext` call wrapped in `loom_icu/2`
 *     (D-I18N-HEEX-ICU).  gettext resolves the message; `ex_cldr_messages`
 *     formats the holes in whatever the ACTIVE LOCALE's translation turned out
 *     to be — which is the point, since a locale may reorder them or use plural
 *     categories English does not have.  The msgid stays ICU verbatim, so the
 *     Phoenix `.po` entry and the other five catalogs remain the same message.
 *
 * `icuFromConcat` is the SHARED re-detector every frontend keys against, so the
 * emitted key equals the catalog key on both branches. */
function heexTranslateCall(
  arg: ExprIR,
  ctx: WalkContext,
  role: string | undefined,
): string | undefined {
  if (!ctx.i18nPrefix || !role) return undefined;
  if (arg.kind === "literal" && arg.lit === "string") {
    const key = messageKey(ctx.i18nPrefix, role, arg.value);
    return `pgettext(${elixirI18nString(key)}, ${elixirI18nString(arg.value)})`;
  }
  const icu = icuFromConcat(arg);
  if (!icu) return undefined;
  const key = messageKey(ctx.i18nPrefix, role, icu.positional);
  const message = `pgettext(${elixirI18nString(key)}, ${elixirI18nString(icu.display)})`;
  // The bindings are a keyword list — the Elixir spelling of the JS runtime's
  // `{ code: code }` values object.  Values are the PEELED raw expressions
  // (a Decimal, a Date), not their stringified form, so the formatter can
  // locale-format rather than re-parse text.
  const bindings = icu.holes
    .map((h) => `${h.name}: ${renderExpr(h.expr, { ...ctx, position: "template" })}`)
    .join(", ");
  return `loom_icu(${message}, [${bindings}])`;
}

/** A user-visible slot in ATTRIBUTE position — a `role="img"` icon's accessible
 *  name, a command `Button`'s `aria-label` (M-T1.11, D-I18N-ATTR).
 *
 *  HEEx was the one frontend that translated every TEXT slot and no ATTRIBUTE
 *  one: `renderInTemplate` carried a role, `renderAttrValue` had nowhere to put
 *  it, so an accessible name shipped in English at every locale while the
 *  visible caption beside it translated.  The attribute form is HEEx's `{…}`
 *  expression syntax (`aria-label={pgettext("…", "Close")}`) — which is exactly
 *  why `elixirI18nString` escapes `{`/`}` in the message.
 *
 *  Returns the QUOTED-OR-BRACED attribute value, or undefined when the caller
 *  should fall back to `renderAttrValue` (i18n off, no role, a dynamic slot) —
 *  keeping every non-i18n path byte-identical. */
export function localizedHeexAttr(
  arg: ExprIR,
  ctx: WalkContext,
  role: string | undefined,
): string | undefined {
  const call = heexTranslateCall(arg, ctx, role);
  return call === undefined ? undefined : `{${call}}`;
}

/** The i18n catalog ROLE of a primitive's NAMED slot (`Button.label` →
 *  `buttonAria`), from the shared `USER_VISIBLE_SLOTS` — the named twin of
 *  {@link positionalRole}, and the same reason: reading the table the
 *  extraction pass reads is what keeps the emitted key equal to the catalog's. */
export function namedRole(primitive: string, name: string): string | undefined {
  return USER_VISIBLE_SLOTS[primitive]?.find((s) => s.kind === "named" && s.name === name)?.role;
}

export function renderChild(child: ExprIR, ctx: WalkContext, role?: string): string {
  const localized = localizedHeex(child, ctx, role);
  if (localized !== undefined) return localized;
  // If the child is itself a primitive call that returns HEEx markup,
  // render it directly without `<%= %>` wrapping.
  if (child.kind === "call" && isHEExCall(child.name, ctx)) {
    return renderExpr(child, ctx);
  }
  if (child.kind === "literal" && child.lit === "string") {
    return escapeHeexText(child.value);
  }
  // `match` self-wraps in `<%= %>` when rendered in template position
  // (renderMatch) — the same reason the isHEExCall check above exists:
  // wrapping an already-wrapped expression produces
  // `<%= <%= cond do … end %> %>`, invalid HEEx.
  if (child.kind === "match") {
    return renderExpr(child, { ...ctx, position: "template" });
  }
  return `<%= ${renderExpr(child, { ...ctx, position: "template" })} %>`;
}

export function renderInTemplate(arg: ExprIR, ctx: WalkContext, role?: string): string {
  const localized = localizedHeex(arg, ctx, role);
  if (localized !== undefined) return localized;
  if (arg.kind === "literal" && arg.lit === "string") return escapeHeexText(arg.value);
  // HEEx-generating calls should not be wrapped in <%= %>.
  if (arg.kind === "call" && isHEExCall(arg.name, ctx)) {
    return renderExpr(arg, ctx);
  }
  // See renderChild — `match` already wraps itself.
  if (arg.kind === "match") {
    return renderExpr(arg, { ...ctx, position: "template" });
  }
  return `<%= ${renderExpr(arg, { ...ctx, position: "template" })} %>`;
}

/** True when an authored value can be an HTML attribute value at all.
 *
 *  A LIST / OBJECT / LAMBDA is not a string and has no attribute spelling.  An
 *  emitted `cols={[3, 2, 1]}` hands Phoenix's attribute escaper a list at
 *  RENDER time — never at compile time, which is why every compile gate was
 *  blind to it — and `Phoenix.HTML.Safe.List` reads it as IODATA: verified in
 *  the generated app, `[3, 2, 1]` renders as the raw bytes `<<3, 2, 1>>`
 *  (control characters in the attribute) and a list carrying anything that is
 *  not a byte/binary/list raises "lists in Phoenix.HTML and templates may only
 *  contain integers representing bytes, binaries or other lists".  Garbage or
 *  a 500 — neither is an attribute.  The one seam every attribute value
 *  funnels through refuses them, and the caller drops the attribute. */
export function isAttrRenderable(arg: ExprIR): boolean {
  return arg.kind !== "list" && arg.kind !== "object" && arg.kind !== "lambda";
}

/** Render an attribute VALUE, or `undefined` when the authored value cannot be
 *  one (see {@link isAttrRenderable}) — callers must skip the attribute then. */
function renderAttrValue(arg: ExprIR, ctx: WalkContext, isStatic: boolean): string | undefined {
  if (!isAttrRenderable(arg)) return undefined;
  // Quote a literal attribute value with `"` / `&` entity-escaped so a
  // `.ddd`-sourced value can't close the attribute or open an entity
  // (`data-testid={"a\"b"}` would break the HEEx tokenizer).
  if (arg.kind === "literal" && arg.lit === "string") {
    return `"${escapeHeexAttr(arg.value)}"`;
  }
  if (isStatic && arg.kind === "literal") {
    return `"${escapeHeexAttr(arg.value)}"`;
  }
  return `{${renderExpr(arg, { ...ctx, position: "template" })}}`;
}

// ---------------------------------------------------------------------------
// Lambda hoisting → handle_event clauses.
// ---------------------------------------------------------------------------

function hoistLambdaToHandler(arg: ExprIR, ctx: WalkContext): string {
  if (arg.kind !== "lambda") {
    // Not a lambda — try to lower as expression in handler context.
    // Caller will get back something it can put in `phx-click="…"`.
    return "noop";
  }
  // Event name is scoped to this page's walk: each hoist pushes exactly one
  // handler onto ctx.handlers (shared by reference across nested renders), so
  // its length gives a per-page sequence that resets for the next page and is
  // deterministic regardless of how many pages were walked before.
  // Namespaced by the owning component so a component's inline lambda and the
  // host page's own `event_1` don't collide once the host hoists both.  A page
  // body keeps the bare `event_<n>` (byte-identical).
  const eventName = ctx.stateOwner
    ? `${snake(ctx.stateOwner)}_event_${ctx.handlers.length + 1}`
    : `event_${ctx.handlers.length + 1}`;
  // Lambda body — either single-expression or block.
  const bodyLines: string[] = [];
  bodyLines.push(`    socket =`);
  if (arg.block) {
    const stmtLines = arg.block.map((s) => renderStmt(s, ctx));
    bodyLines.push(`      socket`);
    for (const line of stmtLines) bodyLines.push(`      ${line}`);
  } else if (arg.body) {
    // Single-expression lambda — typically `() => navigate(...)`.
    const expr = renderExpr(arg.body, { ...ctx, position: "handler" });
    bodyLines.push(`      ${expr}`);
  } else {
    bodyLines.push(`      socket`);
  }
  bodyLines.push(`    {:noreply, socket}`);
  ctx.handlers.push({
    name: eventName,
    paramsPattern: "_params",
    body: bodyLines,
  });
  return eventName;
}

function renderStmt(stmt: StmtIR, ctx: WalkContext): string {
  switch (stmt.kind) {
    case "assign": {
      // state.field := value  →  |> assign(:field, value)
      // Path's first segment is the state field name.  Delegates
      // the pipe-assign shape to `heexTarget.renderStateWrite`
      // (cross-framework contract — see src/generator/_walker/target.ts).
      // We don't carry the full `StateFieldIR` at this site, so pass
      // a minimal-shape StateRef — the target's `renderStateWrite`
      // consumes only the `.name` slot.  When/if the contract grows
      // a method that consults the field's type, this site threads
      // the full StateFieldIR via `ctx.page.state` lookup.
      const fieldName = stmt.target.segments[0];
      if (!fieldName) return `# bad assign`;
      const value = renderExpr(stmt.value, { ...ctx, position: "handler" });
      const stateRef = {
        field: { name: fieldName, type: { kind: "primitive" as const, name: "string" as const } },
        name: hostStateAssignIfOwned(fieldName, ctx),
      };
      return heexTarget.renderStateWrite(stateRef, value);
    }
    case "let": {
      const value = renderExpr(stmt.expr, { ...ctx, position: "handler" });
      return `|> tap(fn _ -> ${snake(stmt.name)} = ${value} end)`;
    }
    case "expression": {
      const e = renderExpr(stmt.expr, { ...ctx, position: "handler" });
      // If this is a navigate/toast call, route the socket through it.
      if (
        stmt.expr.kind === "call" &&
        (stmt.expr.name === "navigate" || stmt.expr.name === "toast")
      ) {
        return `|> then(fn socket -> ${e} end)`;
      }
      return `|> tap(fn _ -> ${e} end)`;
    }
    case "add":
    case "remove": {
      // `count += 1` / `count -= 1` lower to `add` / `remove` (the same
      // IR kinds collection mutations use).  In a LiveView page handler
      // the only meaningful target is a page-`state` field: emit a
      // pipe-assign whose value reads the field's current handler-scope
      // value (`socket.assigns.<f>`) and either does compound arithmetic
      // (scalar) or list append/remove (collection).  Mirrors the React
      // walker's `emitStmt` add/remove arm, re-shaped to the socket pipe.
      const fieldName = stmt.target.segments[0];
      if (!fieldName) return `# bad ${stmt.kind}`;
      const stateRef = {
        field: { name: fieldName, type: { kind: "primitive" as const, name: "string" as const } },
        name: hostStateAssignIfOwned(fieldName, ctx),
      };
      const rhs = renderExpr(stmt.value, { ...ctx, position: "handler" });
      // Nested target (`order.total += v`) reads the dotted handler path;
      // a single-segment field reads via the state seam.
      const read =
        stmt.target.segments.length === 1
          ? heexTarget.renderStateRead(stateRef, "handler")
          : `socket.assigns.${[stateRef.name, ...stmt.target.segments.slice(1).map((s) => snake(s))].join(".")}`;
      const value = stmt.collection
        ? stmt.kind === "add"
          ? `${read} ++ [${rhs}]`
          : `Enum.reject(${read}, &(&1 == ${rhs}))`
        : `${read} ${stmt.kind === "add" ? "+" : "-"} ${rhs}`;
      return heexTarget.renderStateWrite(stateRef, value);
    }
    case "precondition":
    case "requires": {
      // Guard statement in a handler body → keep the socket when the
      // predicate holds, otherwise flash and halt the rest of the chain.
      // `requires` is an authorization gate (forbidden); `precondition`
      // is a domain check.  Both surface as a server-side flash since a
      // page handler can't raise the way a domain action does.
      const pred = renderExpr(stmt.expr, { ...ctx, position: "handler" });
      const msg = stmt.kind === "requires" ? "Forbidden" : "Precondition failed";
      return `|> then(fn socket -> if ${pred}, do: socket, else: put_flash(socket, :error, ${JSON.stringify(`${msg}: ${stmt.source}`)}) end)`;
    }
    case "emit": {
      // Broadcast a domain event over Phoenix.PubSub.  No changeset in a
      // page handler, so the struct is built inline and piped via `tap`
      // (the socket flows through unchanged).  Module prefix uses the
      // app module — page handlers don't carry a per-context module.
      const fields = stmt.fields
        .map((f) => `${snake(f.name)}: ${renderExpr(f.value, { ...ctx, position: "handler" })}`)
        .join(", ");
      const moduleName = upperFirst(stmt.eventName);
      return `|> tap(fn _ -> Phoenix.PubSub.broadcast(${ctx.appModule}.PubSub, "events", %${ctx.appModule}.Events.${moduleName}{${fields}}) end)`;
    }
    case "call": {
      if (stmt.target === "store-action" && stmt.store) {
        // `Cart.clear()` / `Cart.add(sku)` from a page/component action body
        // (Stage 5).  A pipe step over the socket: `|> update(:cart, …)`
        // applies the pure store-module fn to the store's per-page assign.
        // (Same-store action→action composition is pure and handled inside the
        // store module; a page calling a store action lands here.)  Record the
        // use so the LiveView emitter seeds the `:cart` assign + alias.
        ctx.usedStores.add(stmt.store);
        const assign = snake(stmt.store);
        const module = upperFirst(stmt.store);
        const fn = snake(stmt.name);
        if (stmt.args.length === 0) {
          return `|> update(:${assign}, &${module}.${fn}/1)`;
        }
        const callArgs = stmt.args
          .map((a) => renderExpr(a, { ...ctx, position: "handler" }))
          .join(", ");
        return `|> update(:${assign}, fn c -> ${module}.${fn}(c, ${callArgs}) end)`;
      }
      if (stmt.target === "action") {
        // Sibling action→action call (Proposal A Stage 1, Fix 1).  LiveView
        // can't cleanly call one `handle_event` clause from another — the
        // callee is a clause, not a callable function that returns a piped
        // socket.  Inline the callee action's body pipe-steps at the call site
        // instead (the same shape the hoist at `walkBodyToHeex` emits), so the
        // socket flows through the callee's effects and back.  This is the
        // HEEx analogue of the JS frontends marking the callee used.
        if (ctx.actionInlineStack?.has(stmt.name)) {
          // Cycle — already inlining this action higher in the chain.  Emit a
          // no-op marker rather than recurse (the validator owns the cycle
          // diagnostic; codegen just must not loop).
          return `|> tap(fn _ -> :ok end) # action '${snake(stmt.name)}' cycle (HEEx)`;
        }
        const callee = ctx.page.actions?.find((a) => a.name === stmt.name);
        if (!callee) {
          // No such action in scope — the validator owns the diagnostic; codegen
          // must not emit a call to a function that does not exist.
          return `|> tap(fn _ -> :ok end) # action '${snake(stmt.name)}' not found`;
        }
        if (callee.body.length === 0) return "|> tap(fn _ -> :ok end)";
        // A PARAMETERISED callee inlines the same way, with its parameters
        // bound to the caller's arguments — rendered here, in the CALLER's
        // scope, and substituted at each `ref` inside the callee body
        // (`ctx.actionArgSubst`).  Elixir has no way to introduce a binding
        // mid-pipe, so substitution is the inline; the arguments are pure
        // expressions, so evaluating them once per use is equivalent.
        const subst = new Map<string, string>();
        callee.params.forEach((p, i) => {
          const arg = stmt.args[i];
          if (arg) subst.set(p.name, renderExpr(arg, { ...ctx, position: "handler" }));
        });
        const innerCtx: WalkContext = {
          ...ctx,
          actionInlineStack: new Set([...(ctx.actionInlineStack ?? []), stmt.name]),
          // Replaces (never merges) the caller's substitutions: the callee's
          // body resolves ITS parameter names, and the arguments that carried
          // the caller's own parameters were already rendered above.
          actionArgSubst: subst,
        };
        return callee.body.map((s) => renderStmt(s, innerCtx)).join("\n      ");
      }
      // `navigate(<Page>)` — the DOCUMENTED navigation shape (docs/actions.md).
      // It is a `private-operation` call, so it fell into the bare-call line
      // below and emitted `|> tap(fn _ -> navigate(other) end)`: an undefined
      // function AND an unbound `other`, i.e. an Elixir CompileError.  Routed
      // through the SAME resolver the expression position uses; `then/2` gives
      // the mid-pipe socket the `push_navigate(socket, …)` shape needs.
      if (stmt.name === "navigate" && stmt.target === "private-operation") {
        return `|> then(fn socket -> ${renderNavigate(stmt.args, ctx)} end)`;
      }
      // Bare function / private-operation call statement.  Evaluated for
      // its effect; the socket flows through unchanged via `tap`.
      const args = stmt.args.map((a) => renderExpr(a, { ...ctx, position: "handler" })).join(", ");
      return `|> tap(fn _ -> ${snake(stmt.name)}(${args}) end)`;
    }
    case "return": {
      // Elixir has no `return`; a page handler has no value sink, so the
      // expression is evaluated for effect and the socket flows through.
      const e = renderExpr(stmt.value, { ...ctx, position: "handler" });
      return `|> tap(fn _ -> ${e} end)`;
    }
    case "variant-match":
      // `match await <api>.<Agg>.<op>(args) { … }` (async-actions-and-effects.md
      // Stage 2).  On LiveView the async boundary is server-side, not the
      // client-side await the JS frontends emit: load the route-id record, run
      // the aggregate's returning-op context fn, and `case` on its tagged Result
      // tuple — the SAME `{:ok, v}` / `{:error, "<tag>", data}` shape the
      // returning-op controller action produces (operation-returns-emit), here
      // re-shaped to a socket-piped `then/2` step so each arm threads assigns.
      return renderVariantMatchStmt(stmt, ctx);
  }
}

// ---------------------------------------------------------------------------
// `match await` (Stage 2) — server-side effect-form variant match.
// ---------------------------------------------------------------------------

/** Extract `{aggregate, operation, args}` from an awaited variant-match subject.
 *  Handles both the api-param-prefixed form (`<api>.<Agg>.<op>(args)`, Pattern
 *  B/A) and the bare-aggregate form (`<Agg>.<op>(args)`, Pattern E/D) — for the
 *  awaited match the aggregate name is all we need (the api handle only selected
 *  the bounded context, which `contextModuleByAggName` already resolves). */
function detectAwaitedOp(
  subject: ExprIR,
): { aggName: string; opName: string; args: ExprIR[] } | null {
  if (subject.kind === "method-call") {
    const aggName = qualifierName(subject.receiver);
    if (aggName) return { aggName, opName: subject.member, args: subject.args };
  }
  if (subject.kind === "member") {
    const aggName = qualifierName(subject.receiver);
    if (aggName) return { aggName, opName: subject.member, args: [] };
  }
  return null;
}

/** The aggregate name a `match await` subject is qualified by: the LAST segment
 *  of the receiver chain, whatever its depth.  `Order` in each of `Order.op()`,
 *  `Api.Order.op()` and any deeper `a.b.Order.op()` qualification — only the
 *  aggregate matters here, since `contextModuleByAggName` already resolves the
 *  bounded context the api handle would have selected. */
function qualifierName(recv: ExprIR): string | null {
  if (recv.kind === "member") return recv.member;
  if (recv.kind === "ref") return recv.name;
  return null;
}

/** Render an awaited `match await <op>() { … }` as a socket-piped `then/2` step.
 *  Mirrors the returning-op controller action (operation-returns-emit): load the
 *  route-id record, run the op's context fn, `case` on the `{:ok, v}` /
 *  `{:error, "<tag>", data}` tuple.  Each arm is a socket pipe-chain; `else` and
 *  any unmatched outcome (`{:error, %Ecto.Changeset{}}`) fall through to the
 *  socket unchanged, keeping the `case` total.
 *
 *  The op is dispatched through `apply/3` on purpose: Elixir 1.18's type checker
 *  narrows a direct cross-module call's result to the op body's inferred variants
 *  and would flag the `{:ok, _}` arm as unreachable for an always-rejecting op
 *  (the exact pitfall the controller sidesteps with a public `_result/2` helper —
 *  operation-returns-emit §"unused clause").  `apply/3` returns `term()`, so
 *  every arm stays reachable under `--warnings-as-errors`. */
function renderVariantMatchStmt(
  stmt: Extract<StmtIR, { kind: "variant-match" }>,
  ctx: WalkContext,
): string {
  // An unrecognised subject used to render a `tap(fn _ -> :ok end)` marker —
  // valid Elixir that silently did nothing at runtime.  Fail at CODEGEN
  // instead: the awaited call is the whole point of the statement, so dropping
  // it is never the right answer.
  const detected = detectAwaitedOp(stmt.subject);
  if (!detected) {
    throw new Error(
      `platform: elixir — a variant \`match\` statement on page '${ctx.page.name}' has a subject the LiveView emitter cannot resolve to an aggregate operation (ExprIR kind '${stmt.subject.kind}'). A LiveView discriminates a union by RUNNING the operation server-side, so the subject must be the awaited call itself: \`match await <Aggregate>.<operation>(…)\` (optionally api-qualified).`,
    );
  }
  const { aggName, opName, args } = detected;
  const agg = ctx.aggregatesByName.get(aggName);
  if (!agg) {
    throw new Error(
      `platform: elixir — \`match await\` on page '${ctx.page.name}' resolves to '${aggName}.${opName}', but '${aggName}' is not an aggregate served by this deployable, so there is no context function to run.`,
    );
  }
  const ctxModule = ctx.contextModuleByAggName.get(aggName) ?? ctx.appModule;
  const aggSnake = snake(aggName);
  const opSnake = snake(opName);
  const op = agg?.operations.find((o) => o.name === opName);
  const hctx: WalkContext = { ...ctx, position: "handler" };
  // op params → string-keyed attrs map (mirrors the controller's
  // `attrs = Map.drop(params, ["id"])`, string keys from the JSON body).
  const params = op?.params ?? [];
  const attrs =
    params.length === 0
      ? "%{}"
      : `%{${params
          .map(
            (p, i) =>
              `${JSON.stringify(snake(p.name))} => ${args[i] ? renderExpr(args[i]!, hctx) : "nil"}`,
          )
          .join(", ")}}`;
  // One `case` clause per arm; the arm body is a socket pipe-chain (empty ⇒ bare
  // `socket`).  `binder`/`snake(binding)` match render-expr's `match-binding`
  // fallback so `o.code` inside the arm resolves to the bound clause var.
  const armClause = (pattern: string, body: readonly StmtIR[]): string => {
    const steps = body.map((s) => renderStmt(s, hctx));
    const piped = steps.length ? ["socket", ...steps].join("\n              ") : "socket";
    return `            ${pattern} ->\n              ${piped}`;
  };
  // Classify the error variant.  The lowered `arm.isError` hint is unreliable
  // from a UI body (a context-local `error` type doesn't resolve in the page's
  // lowering env — same caveat the JS walker documents), so treat the success
  // variant as the aggregate's own type and any other tag as an error.  Honour a
  // `true` hint too, for the case where lowering DID resolve it.
  const clauses = stmt.arms.map((arm) => {
    const tag = variantTag(arm.varType);
    const isError = arm.isError === true || tag !== aggName;
    const steps = arm.body.map((s) => renderStmt(s, hctx));
    // Elixir's `--warnings-as-errors` rejects a bound-but-unused pattern var, so
    // prefix the binder with `_` when the arm body never references it (e.g.
    // `Blocked _b -> assign(:message, "blocked")`).
    const raw = arm.binding ? snake(arm.binding) : "_";
    const used = arm.binding ? steps.some((st) => new RegExp(`\\b${raw}\\b`).test(st)) : false;
    const binder = arm.binding && !used ? `_${raw}` : raw;
    const pattern = isError ? `{:error, ${JSON.stringify(tag)}, ${binder}}` : `{:ok, ${binder}}`;
    const piped = steps.length ? ["socket", ...steps].join("\n              ") : "socket";
    return `            ${pattern} ->\n              ${piped}`;
  });
  // Catch-all keeps the inner `case` total (unmatched error variants + the
  // audited-op `{:error, %Ecto.Changeset{}}`): run the `else` body if present,
  // else thread the socket through unchanged.
  clauses.push(armClause("_", stmt.elseBody ?? []));
  const notFoundMsg = JSON.stringify(`${upperFirst(aggName)} not found`);
  return [
    `|> then(fn socket ->`,
    `        case ${ctxModule}.get_${aggSnake}(socket.assigns.id) do`,
    `          {:ok, record} ->`,
    `            case apply(${ctxModule}, :${opSnake}_${aggSnake}, [record, ${attrs}]) do`,
    ...clauses,
    `            end`,
    `          {:error, :not_found} ->`,
    `            put_flash(socket, :error, ${notFoundMsg})`,
    `        end`,
    `      end)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// `requires` page-level guard → handle_params guard expression.
// ---------------------------------------------------------------------------

/** Render a `requires <pred>` guard for `handle_params/3`.  Returns
 *  null when the page has no guard.  Caller wraps in
 *  `if not (<pred>), do: push_navigate(socket, to: "/")`. */
export function renderRequiresGuard(page: PageIR, ui: UiIR, appModule: string): string | null {
  return renderRequiresGuardAt(page, ui, appModule, "handler");
}

/** Render a page's `requires <pred>` in HEEx *template* scope — the
 *  current-user claim resolves to `@current_user` rather than the
 *  handler-scope `socket.assigns.current_user`.  Used by the sidebar
 *  emitter to gate a nav link inside a `<%= if (<gate>) do %>` against the
 *  layout-assigned `@current_user`.  Returns null when the page has no
 *  `requires` clause. */
export function renderRequiresGuardInTemplate(
  page: PageIR,
  ui: UiIR,
  appModule: string,
): string | null {
  return renderRequiresGuardAt(page, ui, appModule, "template");
}

function renderRequiresGuardAt(
  page: PageIR,
  ui: UiIR,
  appModule: string,
  position: RenderPosition,
): string | null {
  if (!page.requires) return null;
  const ctx: WalkContext = {
    appModule,
    aggregatesByName: new Map(),
    bcByAggregate: new Map(),
    projectionsByName: new Set(),
    listShapedProjections: new Set(),
    enumsByName: new Map(),
    valueObjectsByName: new Map(),
    idOptionsBindings: new Set(),
    formBindings: [],
    queryBindings: [],
    page,
    ui,
    stateNames: new Set(page.state.map((f) => snake(f.name))),
    stateFields: new Map(page.state.map((f) => [snake(f.name), f])),
    handlers: [],
    actionBindings: [],
    usedComponents: new Set(),
    componentUses: new Map(),
    slotUsed: { value: false },
    chartUsed: { value: false },
    tabSeq: { value: 0 },
    tableSeq: { value: 0 },
    usedStores: new Set(),
    uploadBindings: [],
    tableControls: [],
    position,
    partContextModule: new Map(),
    contextModuleByAggName: new Map(),
  };
  return renderExpr(page.requires, ctx);
}

// ---------------------------------------------------------------------------
// Component state lifting.
//
// A HEEx function component is a pure render function — it owns no process and
// therefore no state.  React gives `component C { state { n } action bump() }`
// a per-instance `useState`; the LiveView equivalent is to LIFT `n` into the
// host page's assigns and pass it back down as an attr, while `bump` becomes a
// `handle_event` clause on that same host LiveView.  Every reference — the
// component's own template `@counter_n`, the host's `assign(:counter_n, …)`,
// the call site's `counter_n={@counter_n}` — spells the ONE namespaced name, so
// forwarding through an intermediate component needs no rewriting.
// ---------------------------------------------------------------------------

/** Host-LiveView assign name for a `state { … }` field: bare for a page's own
 *  state, `<component>_<field>` for a component's lifted state. */
export function hostStateAssign(owner: string | undefined, field: string): string {
  return owner ? `${snake(owner)}_${snake(field)}` : snake(field);
}

/** `hostStateAssign` for a mutation target — namespaced only when the target
 *  really is one of THIS body's declared state fields (a dotted path into an
 *  aggregate instance, or a name the body doesn't own, is left alone). */
function hostStateAssignIfOwned(field: string, ctx: WalkContext): string {
  return ctx.stateNames.has(snake(field)) ? hostStateAssign(ctx.stateOwner, field) : snake(field);
}

/** Every lifted state field a component invocation must be passed — its own,
 *  plus (transitively) those of the components it renders, since an
 *  intermediate function component can only forward what it was itself given.
 *  Ordered by owning component then declaration, deduped by assign name. */
export function liftedStateAttrs(
  comp: ComponentIR,
  ui: UiIR,
): { assign: string; field: StateFieldIR }[] {
  const out = new Map<string, { assign: string; field: StateFieldIR }>();
  const seen = new Set<string>();
  const visit = (c: ComponentIR): void => {
    if (seen.has(c.name)) return;
    seen.add(c.name);
    for (const f of c.state) {
      const assign = hostStateAssign(c.name, f.name);
      if (!out.has(assign)) out.set(assign, { assign, field: f });
    }
    for (const nested of collectComponentCalls(c.body, ui)) visit(nested);
  };
  visit(comp);
  return [...out.values()];
}

/** User `component`s invoked anywhere in an expression tree. */
function collectComponentCalls(root: ExprIR | undefined, ui: UiIR): ComponentIR[] {
  const out: ComponentIR[] = [];
  const visit = (e: ExprIR | undefined): void => {
    if (!e || typeof e !== "object") return;
    if (e.kind === "call") {
      const hit = ui.components.find((c) => c.name === e.name);
      if (hit) out.push(hit);
    }
    for (const v of Object.values(e as Record<string, unknown>)) {
      if (Array.isArray(v)) for (const el of v) visit(el as ExprIR);
      else if (v && typeof v === "object" && "kind" in (v as object)) visit(v as ExprIR);
    }
  };
  visit(root);
  return out;
}

// ---------------------------------------------------------------------------
// State field default values — type-aware.  Caller invokes
// `defaultInitFor(field)` when the field has no explicit `= <init>`.
// ---------------------------------------------------------------------------

/** A page-state field's seed value for `mount/3`: its declared `= <init>`
 *  (lowered into `StateFieldIR.init`) when present, else the type's zero value.
 *
 *  Every other frontend already honours `init` — React/Svelte/Angular from the
 *  start, Vue since the M-T1.1 slice-6 page-shell fix.  Elixir did not, so the
 *  scaffold list's 1-based `pageNum: int = 1` seeded as `0`; harmless while the
 *  assign was unread, but `page = 0` drives `offset = (page - 1) * page_size`
 *  negative once the value actually reaches `list/4`.
 *
 *  Only LITERAL inits render here.  A non-literal init on page state would need
 *  the full expression renderer (and a walk context this function has no access
 *  to); falling back to the type default keeps such a page byte-identical
 *  rather than emitting something that might not compile. */
export function stateInitFor(f: StateFieldIR): string {
  if (f.init?.kind === "literal") return elixirLiteral(f.init.lit, f.init.value);
  return defaultInitFor(f.type);
}

/** Render a lowered literal as an Elixir term.  Mirrors the store emitter's
 *  private literal renderer; kept here because state seeding is this module's
 *  concern (`defaultInitFor`'s neighbour). */
function elixirLiteral(lit: string, value: string): string {
  switch (lit) {
    case "string":
      return JSON.stringify(value);
    case "int":
    case "long":
      return value;
    case "bool":
      return value === "true" ? "true" : "false";
    case "decimal":
    case "money":
      // Decimal-backed — never a bare float literal (precision loss).
      return `Decimal.new(${JSON.stringify(value)})`;
    case "null":
      return "nil";
    default:
      return JSON.stringify(value);
  }
}

export function defaultInitFor(t: TypeIR): string {
  switch (t.kind) {
    case "optional":
      return "nil";
    case "primitive":
      switch (t.name) {
        case "int":
        case "long":
          return "0";
        case "decimal":
        case "money":
          // Both are Decimal structs — zero is `Decimal.new("0")`.
          return `Decimal.new("0")`;
        case "bool":
          return "false";
        case "string":
        case "guid":
          return `""`;
        case "datetime":
          return "DateTime.utc_now()";
        default:
          return "nil";
      }
    case "id":
      return "nil";
    case "array":
      return "[]";
    default:
      return "nil";
  }
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

// the target through the cross-framework contract above; this file
// no longer carries the path → module name derivation.

export function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((line) => (line.length > 0 ? pad + line : line))
    .join("\n");
}

// Unused-import suppression for re-exports.
