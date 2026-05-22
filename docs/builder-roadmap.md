# Visual Builder — roadmap / backlog

Running list of what the in-browser visual **Builder** (`web/src/builder/`) does
today and what's still open. The Builder edits `.ddd` source visually: it parses
the source, edits a craft.js canvas, and writes the changed construct back via
`onSourceChange` (regenerate-and-splice at the construct's CST range). `.ddd`
text stays the source of truth.

## Done

- **Page Builder MVP** (craft.js): seed a page's `body:` → canvas → "Apply"
  regenerates the body and splices it back.
- **Primitive registry** drives seed / emit / palette / settings in lock-step
  (`web/src/builder/page/model.ts`).
- **Recognize-or-opaque**: anything the canvas can't model round-trips as an
  `Opaque` node carrying its printed source verbatim — the body never corrupts.
- **Container-with-props** (Phase A): containers may carry leading scalar props /
  named modifiers. Recognised: `Stack`/`Group`/`Grid`/`Toolbar`, `Card` (title),
  `Container` (`size:`), `Paper` (`padding:`); leaves `Heading`/`Text`/`Button`/
  `Anchor`/`Badge`/`Alert`/`Empty`/`Divider`; data `List`/`Form` with `of:` /
  `creates:` aggregate bindings. Nested children of recognised containers are
  real editable nodes.
- **Two-way sync** (Phase B): Builder "Apply" pushes the edit into the live Monaco
  model (full-range edit, undo preserved) and the LSP, so the source tab and
  Problems panel reflect it immediately. Origin-tagged `onSourceChange` +
  suppress guard prevent an echo loop. The canvas re-seeds from current source on
  tab activation.
- **`expr` prop kind**: a permissive data-binding prop that accepts any
  expression (member access, calls, literals, refs) except the structured
  Lambda/Match slots, stores its printed text verbatim, and re-emits it unquoted.
  Data-bound display args (`Badge(order.status)`, `Stat("Total", order.total)`)
  now seed as editable nodes instead of Opaque. Settings panel renders them as a
  reparse-validated textarea.
- **Full stdlib primitive coverage**: the remaining `STDLIB_LAYOUT_COMPONENTS`
  are recognised — `Stat`/`Money`/`DateDisplay`/`EnumBadge`/`IdLink` (expr
  binding), `Field`/`NumberField`/`PasswordField`/`Toggle` (`bind:`),
  `Image`/`Avatar`, `Skeleton`/`Loader`/`Slot`, `Breadcrumbs`/`KeyValueRow`,
  `Tabs` (+ `Tab` sub-primitive), `Table` (+ `Column` sub-primitive).
- **Lambdas & `match`** (synthetic nodes): a `body: match { … }` seeds editable
  predicate arms (cond + value child) with an optional `else`; lambda accessors
  (e.g. a `Column`'s `o => …`) seed as a param + body child. Modelled as ordinary
  positional-children nodes (`Lambda`/`Match`/`MatchArm`/`MatchElse`) so the
  serialize/craft path is unchanged.
- **Component editing**: the body picker collects both page `body:` and
  `component` `body:` expressions, so reusable components are editable too.
- **Named-arg child slots**: args whose value is itself a node and that arrive
  *named* — `QueryView(loading:/error:/empty:/data:)`, `Table(onRowClick:/
  rowTestid:)` callbacks, `Modal(trigger:)`. Seeded as `slot`-tagged children
  (flat children, no craft `linkedNodes`); the slot survives craft's
  `SerializedNodes` round-trip via a reserved `__slot` prop. `data:` lambdas
  nest a `Lambda` body child, so a `QueryView(data: rows => Table(…))` is
  editable all the way down.
- **Arbitrary arg order**: a node records its source arg order (an `order`
  token list of prop keys + child markers, persisted via a reserved `__order`
  prop) and `emitBody` replays it, so a positional after a named arg — the
  common hand-written `Table(rows: x, Column(…), Column(…))` — round-trips
  instead of falling back to Opaque. Replay is edit-safe: children are pulled in
  array order, and children/named props added after seed are appended; fresh
  palette nodes (no recorded order) still emit in canonical order.
- **Passthrough modifiers + optional args**: an unmodelled named arg
  (`testid:`/`striped:`/`gap:`/…) is kept as a verbatim passthrough prop —
  editable as a generic expr field, surfaced in the settings panel — instead of
  collapsing the node to Opaque; and declared positionals are optional from the
  right (`Empty()` is recognised). See also event-handler lambdas, below.
- **Expression-valued text**: text content (`Heading`/`Text`/`Button`/`Anchor`/
  `Alert`/`Empty`) is a `text` kind — a plain text box for a string literal,
  the raw expression otherwise — so `Text("Hello, " + name)` is editable rather
  than Opaque.
- **In-canvas add-arm / add-child**: a selected `Match` shows "+ arm"/"+ else"
  controls (arms aren't palette primitives); the palette won't drop a raw
  primitive into a Match or an already-full single-child slot.
- **Event-handler lambdas + qualified refs**: an unknown named arg whose value
  is a lambda (`Button(onClick: e => { … })`, form `onSubmit`) becomes an
  editable slot child — a `Lambda` node (with the statement-row editor for block
  bodies), rendered nested inside the carrying primitive (leaves render their
  slot children too) — instead of a raw passthrough string or Opaque; and a
  `ref` slot accepts a qualified ref (`Form(of: Sales.Order)`), surfaced as the
  current value in its dropdown.
- **`Detail` / `MasterDetail` + user-component calls**: `Detail(of:, by:)` and
  `MasterDetail(of:, …, detail: o => …)` are recognised; and a call to a
  user-defined `component` (collected from the source with its param names,
  registered in the craft resolver) is recognised, its positional args modelled
  as props **labelled by the declared param name**. A non-component value call
  (`format(x)`) stays an expression.
- **Typed binding pickers**: `Form(op:)` is a dropdown of the bound `of:`
  aggregate's operations (contextual — it follows the selected `of:`);
  `Form(runs:)` lists workflows. Aggregate/workflow/view option sets are
  collected from the source (`BuilderPane`); `op:` is contextual via the
  per-aggregate operations map.  A boolean-valued modifier (`striped: true`)
  edits as a switch, and `color:` (Badge/Alert) is a palette dropdown.
- **Statement-level handler editor**: a block-bodied lambda (any named-arg
  handler — `Button(onClick:)`, form `onSubmit`, `Table(onRowClick:)`) seeds as a
  `Lambda` node holding one editable `Stmt` row per statement; rows are
  add/edit/delete/reorderable and round-trip. An **assignment** statement
  (`target := value`, `+=`, `-=`) is structured into target / op / value
  controls; other statements keep their verbatim source row.
- **Page state editing**: a "State (N)" popover in the page-builder toolbar lists
  the selected page's `state {}` fields (`web/src/builder/page/StatePanel.tsx`)
  and adds / deletes / retypes / sets-default them, splicing the block via the
  structural printer (`web/src/builder/page/state-fields.ts`, reusing the Model
  builder's `fields.ts` TypeRef helpers). Creates a `state {}` if the page has
  none. Rename is excluded (state-field names are referenced in the body via IR
  lowering, not as Langium cross-references).

## Open — expression / domain-logic surface

- **Per-statement structure** — assignments are structured (target/op/value);
  the remaining statement kinds (`call`, `emit`, `navigate`, `let`) still edit
  as a raw source row — structured editors for them are a further step.
- **More typed pickers**: enum-case values (needs the field's enum type) and
  repository finds (op/runs/aggregate/workflow/color/boolean pickers are done;
  qualified refs already round-trip).
- **`match` arm cond caveat** — the grammar misparses a *bare-identifier* arm
  cond (`ready => …`) as a lambda, so such conds must be comparisons/calls. Emit
  reproduces the original (valid) cond, so round-trip is safe; the "+ arm"
  control defaults the cond to `true` (a non-bare-ident expression).

## Open — editing UX

- **Mobile** Builder tab (desktop-only today).
- **Continuous text→canvas live sync** (today re-seeds on tab switch, not per
  keystroke) — needs debounce + canvas selection preservation.

Done: **drag-to-add / drag-reorder** — palette items wire craft's `create`
connector (drag onto a canvas to create; click still adds to the selected/top
container), and existing nodes drag-reorder across containers (craft's `drag`
connector); both write the new tree back on Apply.
Also done: **component editing** (the body picker now lists `page` and `component`
bodies); **inline `expr`/`raw` validation** in the settings panel; **diagnostics**
(a problems bar above the canvas *and* a red outline + tooltip on the specific
node each diagnostic came from, via each node's recorded `__range`).

## System / Model Builder (Phase C)

Done:

- **Structural printer** — `src/language/print/print-structural.ts` (AST→source
  for systems/modules/aggregates/VOs/events/repositories/views/workflows/
  deployables/apis/storages/uis/traceability), gated by
  `test/print-structural-roundtrip.test.ts` over the example corpus.
- **"Model" tab** — a React Flow (`@xyflow/react`) graph
  (`web/src/builder/system/`): one node per construct, edges for the clear
  cross-references (repository→aggregate, api→module, deployable→module/ui/api,
  view→aggregate). Loads lazily (its own chunk) when the tab is opened.
- **Editing**: select a node → see its printed source; **add** and **delete**
  splice the backing CST range via `edit-engine.ts` and write back through
  origin-tagged `onSourceChange` (Phase B sync). Add covers **every** node kind
  from minimal valid templates (`constructTemplate`), parse-guarded before
  applying: module + context-level domain constructs (aggregate / value object /
  event / workflow, and repository / view — gated on an aggregate) into the first
  context, and system-level infra (storage / ui / deployable, and api — gated on a
  module) into the system. e2e: `web/e2e/system-builder.spec.ts`.
- **Rename** a construct *and every reference to it* (repo `for`, `Id<X>` part
  types, `from`, deployable bindings). The main-thread parse isn't linked, so
  rename spins up a throwaway fully-built Langium document and uses
  `References.findReferences` for the exact CST span of each reference
  (`web/src/builder/system/rename.ts`). Comments are left intact. Gated by
  `test/system-rename.test.ts` + e2e.
- **Inline field editing** — for Property-bearing constructs (aggregate / value
  object / event), the inspector lists each field with an editable type Select +
  `[]`/`?` checkboxes and a delete control, plus **+ field**. Each op mutates the
  parsed node's property array, reprints via the structural printer, and splices
  (`web/src/builder/system/fields.ts`). Gated by `test/system-fields.test.ts` + e2e.
- **Field rename** — aggregate / value-object field names are editable inline and
  rename **every usage** (`this.field`, bare this-refs, `x.field` member access,
  `field :=` assignment targets, view filters/binds, find filters). Field names
  are plain string tokens, not Langium cross-references, so this reuses the
  language server's shared `member-refs` resolver — the same one the LSP
  Rename/References providers use — which finds usages by *type* (honouring scope
  + local-binding shadowing), never by text (`renameMember` in
  `web/src/builder/system/rename.ts`). As part of this, the shared resolver was
  completed to cover assignment-target (`LValue`) usages and to resolve bare
  this-members in view/find contexts via `envForNode` — improving the LSP rename
  too. Gated by `test/system-rename.test.ts` + `test/lsp-rename.test.ts` + e2e.
- **Reference rebinding** — for single-reference constructs (repository → its
  `for` aggregate, api → its `from` module, view → its `from`/`=` aggregate) the
  inspector shows a Select that rewrites the reference's `$refNode` CST span; the
  graph edge re-derives on the next parse (`web/src/builder/system/rebind.ts`).
  Gated by `test/system-rebind.test.ts` + e2e.
- **Infra construct properties** — the inspector edits the scalar slots of the
  infra constructs: a `storage` node's `type` (postgres / mysql / … dropdown) and
  a `deployable` node's `platform` (hono / dotnet / react / static /
  phoenixLiveView) and `port` (`web/src/builder/system/infra-props.ts`; parse →
  mutate → reprint → splice). Gated by `test/system-infra-props.test.ts` + e2e.
- **Deployable composition bindings** — the deployable inspector edits its
  `modules` and `serves` (multi-selects) and `targets` and sugar `ui` (selects),
  by mutating the binding arrays / refs and reprinting
  (`web/src/builder/system/deployable-bindings.ts`). Editing the module set
  **preserves per-module storage maps** for retained modules; the advanced
  `ui: W { … }` compose / legacy block forms are detected (`uiKind`) and the ui
  picker is hidden so they're never clobbered. Gated by
  `test/system-deployable-bindings.test.ts` + e2e.
- **Operation & workflow body editing** — a shared statement-list editor
  (`web/src/builder/system/body.ts` + `BodyEditor.tsx`) for the two `Statement[]`
  bodies. Workflow nodes edit their body directly; aggregates expose an
  operation picker → that operation's body. Each statement is an editable text
  row committed on blur; an edit/add is spliced and the whole document re-parsed,
  so only syntactically-valid edits commit (semantic errors surface in the
  Problems panel). Statements show verbatim source, so untouched bodies
  round-trip byte-for-byte. Statement **reorder** (↑/↓, swap-in-place) and
  **function bodies** (`FunctionDecl.body` — a single expression, edited inline
  for aggregates/value objects) are included. Gated by `test/system-body.test.ts`
  + e2e.
- **Event wiring** — `event` nodes are wired by deriving `emits` edges from
  `emit` statements in operation/workflow bodies (owner → event). Gated by
  `test/system-model.test.ts`.
- **Structured expression editor (v1)** — a recursive editor
  (`web/src/builder/system/expr-model.ts` + `ExpressionEditor.tsx`) that
  decomposes an expression into an operator tree: binary/unary/paren render
  operator dropdowns with nested operands, literals get typed inputs, calls
  (`f(a, b)`) and member access (`a.b`, `a.b(c)`) render editable callee/receiver
  + member + an add/remove/edit argument list, expression-body lambdas
  (`p => expr`) render an editable param + body (the param is threaded into the
  body's scope suggestions), `new Part { … }` and object literals `{ … }` render
  an editable partType + a named-field list (add/remove/edit), and everything
  still unmodelled (`match`, ternary, block-body lambdas) is a reparse-validated
  `raw` text leaf (recognise-or-raw). Plugged into the
  single-expression slots — invariants, derived props, function bodies — via one
  inspector "Expression" picker (`expr-slots.ts`). A **structured⇄text toggle**
  lets advanced users edit the whole expression as raw text (same
  reparse-on-commit validation). Gated by `test/system-expr.test.ts` + e2e.
- **View editing** — view nodes expose their `where` filter and each `bind`
  expression through the same Expression picker + editor, so views are editable
  in the modeller (`viewSlotOptions` in `expr-slots.ts`). Gated by
  `test/system-expr.test.ts` + e2e.
- **Repository find editing** — repository nodes expose each `find` decl's
  `where` filter through the Expression picker (`repoSlotOptions`), and a **Finds**
  section to edit each find's **return type** and **parameters** (add / delete /
  retype / rename), mirroring field editing (`find-params.ts`: parse → mutate →
  reprint the repository → splice). A param rename also rewrites its bare-`NameRef`
  usages in that find's own filter (the param shadows any same-named member there),
  so it's safe without the cross-document member resolver. Gated by
  `test/system-expr.test.ts`, `test/system-find-params.test.ts` + e2e.
- **Scope-aware name suggestions** — every `raw` leaf in the expression editor
  is an autocomplete fed the in-scope bare names (params, properties, derived
  props, helpers, enum values). The scope rules live in the IR: `inScopeNames`
  sits next to `Env`/`resolveNameRef` in `src/ir/lower-expr.ts`, and the web
  layer (`slotCandidates`/`slotEnv` in `expr-slots.ts`) reuses the IR's `Env`
  builders to construct the per-slot env exactly as `lower.ts` does — so the
  rules aren't forked. Gated by `test/system-expr.test.ts` + e2e.
- **Type-directed member-name completion** — `receiver.‹member›` inputs are
  autocompletes fed the receiver's *type's* members (properties / containments /
  derived / helpers, collection ops on arrays, enum values, `string.length`,
  `Id<X>`/optional unwrapped). The single source of truth is `membersOfType` in
  `src/language/type-system.ts`, **shared with the VS Code LSP completion**
  (`ddd-completion.ts` delegates to it). Receiver types come from the AST type
  system (`typeOf` + `envForNode`), which also gained collection-op lambda-param
  binding and find/view/workflow `this`/param context (so member completion +
  LSP hover/definition/completion now work inside lambdas and in find/view
  filters). Resolving types needs a *linked* document, so candidates are
  computed async via `buildLinkedModel` (shared linked-build helper extracted
  from rename.ts) + `memberCandidates` (a path-keyed map threaded into the
  editor by structural path). Gated by `test/type-system-members.test.ts`,
  `test/system-expr.test.ts` + e2e.
- **Call argument labels (signature help)** — positional call / member-call
  arguments are labelled with the callee's parameter names (`amount:`,
  `currency:`), resolved by type. The single source is `calleeSignature` in
  `src/language/type-system.ts` — a function/operation's params or a value-object
  constructor's properties — **shared with the LSP signature-help provider**
  (`ddd-signature-help.ts` delegates to it, and so gained VO-constructor
  signatures). Labels ride the same async path-keyed hint map as member
  completion (`exprHints` in `expr-slots.ts`). Gated by
  `test/lsp-signature-help.test.ts`, `test/system-expr.test.ts` + e2e.
- **Statement expressions in operation & workflow bodies** — the same
  "Expression" picker lists each aggregate operation's *and workflow's*
  statement expressions as `stmtExpr` / `wfStmt` slots: `precondition` /
  `requires` predicates, `let` values, **assignment right-hand values** (`x :=
  <value>` — only the value is spliced, target/op preserved), and **each `emit`
  field value** (addressed by a `field` index). So domain-logic expressions —
  including `balance := Money(…)` and `emit E { f: <expr> }` — are editable with
  the structured editor (calls, members, `new`, member completion), not just the
  BodyEditor's text rows. Candidates include params and earlier `let` bindings
  (operations also see the aggregate's members; workflows have no `this`). Bare
  calls and the assignment target / event ref stay text-row only. Gated by
  `test/system-expr.test.ts` + e2e.

Open:

- **Deeper expression structuring** — structured `match` and ternary, and
  block-body lambdas (still `raw` leaves); arg-*name* editing on calls (existing
  named args are preserved verbatim but can't be renamed in the UI); and
  structured statement *targets* (assignment LValue / `emit` event picker) +
  bare-call statements — the statement *expressions* are structured today, but
  these non-expression parts stay text-row.
- **Edge rebinding by dragging** connections on the canvas (inspector-Select
  rebinding already exists — see above); plus multi-valued deployable references
  (module bindings, `serves`, ui) which the single-Select rebind doesn't cover.
- **Add** the remaining construct kinds (value object, event, repository, view,
  workflow, deployable, api, storage, ui), and choose the target context/module.
- **Nested grouping** (module → context → members as React Flow parent nodes)
  and auto-layout; today it's a deterministic column-per-kind layout.
- **Persisted positions** (layout is currently derived, not written back).
- **Mobile** Model tab (desktop-only today).
