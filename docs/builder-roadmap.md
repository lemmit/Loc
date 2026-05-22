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
- **Structured `let` + validated statement rows**: a `let x = …` handler
  statement seeds as a structured row (name / reparse-validated value), and the
  verbatim fallback row (bare calls / `navigate(…)` / anything unmodelled) now
  reparse-validates and flags an "Invalid statement". (`emit` isn't a page-handler
  statement — it's domain-side, edited in the system/workflow builder.)
- **Enum-case default picker**: in the State panel, an enum-typed state field's
  default renders as a dropdown of the enum's cases (collected from the source by
  `BuilderPane`; the current value is always selectable so a hand-written default
  isn't clobbered) instead of a free-text input.
- **Mobile Builder + Model tabs**: both builders have a narrow-viewport layout —
  full-width canvas, palette/settings (page) and inspector (model) move into
  bottom drawers, reached via the consolidated Code tab's SegmentedControl
  (`PageBuilder.tsx` / `SystemBuilderPane.tsx`, `ctx.isDesktop`). Gated by
  `web/e2e/mobile-builder.spec.ts`.

## Open — expression / domain-logic surface

- **Per-statement structure** — assignment and `let` are structured; bare
  calls / `navigate(…)` keep a validated single-row editor (a call is one
  expression, so structuring buys little beyond the validation now in place).
- **Structured `navigate(…)` statement** — a `navigate(<page>, <params?>)` bare
  call in a handler block seeds as a structured `Stmt` row: a **target-page
  picker** (dropdown of the source's page names, collected by `BuilderPane`) + an
  optional reparse-validated **params** expression. Mirrors the `let`/assignment
  statement structuring (`seedStmt`/`emitBody` in `page/model.ts`, the settings
  form in `PageBuilder.tsx`). Gated by `test/builder-page-model.test.ts` + e2e.
  Caveat: the **object-literal** params form (`{ customerId: … }`) isn't supported
  — object literals don't parse in the page expression grammar (only in domain
  bodies), so params are a single positional expression; supporting object-literal
  route params would need a grammar change. `navigate(…)` in expression position
  (e.g. inside an `Action(then: …)`) is also still out of reach until `Action` is
  recognised (it currently round-trips as Opaque).
- **More typed pickers**: enum-case values are offered for state-field defaults;
  enum-valued *expressions elsewhere* (assignment values, `match` conds) still
  edit as free text (would need per-position type inference).
- **`match` arm cond caveat** — the grammar misparses a *bare-identifier* arm
  cond (`ready => …`) as a lambda, so such conds must be comparisons/calls. Emit
  reproduces the original (valid) cond, so round-trip is safe; the "+ arm"
  control defaults the cond to `true` (a non-bare-ident expression).

## Open — editing UX

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
  an editable partType + a named-field list (add/remove/edit), and anything still
  unmodelled is a reparse-validated `raw` text leaf (recognise-or-raw). (`match`,
  ternary, and block-body lambdas were since structured — see below.) Plugged
  into the
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
  **call statements** (`x.method(args)`) expose one slot per argument too. Gated by
  `test/system-expr.test.ts` + e2e.
- **Emit event picker** — an "Emits" picker on aggregate / workflow nodes lists
  every `emit` statement (across operations / the workflow body) and repoints it
  at a different event via a dropdown — rewriting just the event-name cross-ref
  token in place (field values preserved), like reference rebinding
  (`web/src/builder/system/emit-event.ts`). Gated by
  `test/system-emit-event.test.ts` + e2e.
- **Structured `match` + ternary** — `cond ? then : else` renders as three
  nested editors; `match { … }` renders its arms (cond `=>` value) with
  add/remove-arm and add/remove-else controls, the new arm defaulting to a safe
  `true => null` (a bare-identifier arm cond would misparse as a lambda). Both
  decompose recursively like the rest of the editor and the type-directed
  member/arg hints thread through the branches (matching paths in `collectHints`).
  `expr-model.ts` + `ExpressionEditor.tsx` + `expr-slots.ts`; gated by
  `test/system-expr.test.ts` + e2e.
- **Structured block-body lambdas** — a `p => { … }` lambda seeds editable
  statement rows (`EStmt` in `expr-model.ts`): `let` and assignment structure
  their value as a nested expression editor (so member completion / arg labels
  thread in), every other statement kind (precondition / requires / emit / bare
  call) keeps its source verbatim. Rows add (`+ let` / `+ assign`, parseable
  defaults) / delete / reorder; the lambda param and earlier `let` bindings are
  threaded into each value's scope. `expr-model.ts` + `ExpressionEditor.tsx`;
  gated by `test/system-expr.test.ts`.
- **Argument-name editing** — a named call argument's name is an editable input
  (clearing it demotes the arg to positional); clicking an inferred parameter-name
  label on a positional arg promotes it to named (`ArgsEditor` in
  `ExpressionEditor.tsx`). Gated by `test/system-expr.test.ts`.
- **Structured assignment target** — in the top-level BodyEditor (operation /
  workflow bodies) an assignment row splits into a dedicated target / op / value
  (`StmtView` in `body.ts`, `AssignRow` in `BodyEditor.tsx`); other statement
  kinds keep their single text row. The op is a `:=` / `+=` / `-=` dropdown; the
  value re-uses the structured Expression picker. Gated by
  `test/system-body.test.ts` + e2e.
- **Diagnostics on graph nodes** — LSP diagnostics (`ctx.diagnostics`) are
  attributed to the construct whose source most tightly contains each (so a
  problem inside an aggregate marks the aggregate, not its module), and that node
  renders a red (error) / yellow (warning) outline + a `✕`/`⚠` count, with the
  messages on the node's `title`. `nodeDiagnostics` in `model.ts` (pure,
  attribution by CST line span); rendering in `SystemBuilderPane.tsx`. Gated by
  `test/system-model.test.ts`.
- **Search / filter / focus** — a canvas-overlay search box (case-insensitive
  substring over name + kind) and a kind multi-select dim non-matching nodes /
  edges in place (positions preserved), with a match count and a **Focus** button
  that `fitView`s to the matches. Pure `matchNodes` in `model.ts`; UI +
  in-place-opacity effect in `SystemBuilderPane.tsx`. Gated by
  `test/system-model.test.ts` + e2e.
- **Traceability coverage overlay** — a **Coverage** toggle recolours the graph
  into a tested / untested / unreferenced heatmap. The linked model is lowered +
  enriched (`lowerModel` → `enrichLoomModel`) off the render path, and its
  `traceability` index maps onto nodes via pure `coverageByNode` in `model.ts`: a
  construct is *covered* if it (or, for an aggregate, an operation under it) is
  referenced by a `solution`/`testCase` and has a covering testCase, *uncovered*
  if referenced but untested, *none* if no artifact references it. Gated by
  `test/system-model.test.ts` (incl. a real lower→enrich→coverage pass over
  `sales-system.ddd`) + e2e.
- **Apply-diff preview** — an opt-in **Preview** toggle: while on, every edit is
  staged in a modal showing its source diff (removed / added lines) and commits
  only on confirm, instead of applying live (off by default, preserving the live
  feel). A no-op edit passes straight through. Pure `lineDiff` in `edit-engine.ts`
  (common-prefix/suffix trim → one tight hunk, since builder edits are localised
  splices); the toggle / modal / `DiffView` live in `SystemBuilderPane.tsx`. Gated
  by `test/generator/builder-splice.test.ts` + e2e.
- **Wire-shape (DTO) preview** — selecting an aggregate / value object shows its
  enrichment-computed `wireShape` — the canonical JSON-on-the-wire field list
  every backend's DTO emitter consumes (`id`, then properties, then containments,
  then derived) — as a `name : type[?] · source` list in the inspector. Lowered +
  enriched from the linked model off the render path; pure `wireShapeOf` +
  `typeLabel` in `model.ts`. Gated by `test/system-model.test.ts` + e2e.
- **Persisted node positions** — hand-dragged positions are saved to
  localStorage (keyed by `<kind>:<name>` node id) and re-applied on every
  re-seed, so a source edit or reload no longer resets the user's arrangement; a
  **Reset layout** button discards them back to the derived column layout.
  Serialize/parse is pure (`positions.ts`, malformed entries dropped); drag-end
  persistence + re-apply wire through `SystemBuilderPane.tsx`. Gated by
  `test/system/system-positions.test.ts` + e2e.

- **Structured bare-call statements** — a bare call (`recv.method(args)`, an
  `LValue` with a trailing call and no mutation suffix) in the BodyEditor splits
  into a head (`recv.method`) plus one editable input per argument, with add /
  delete, reconstructing `head(a, b, …)` on commit (empty args dropped). The new
  `call` `StmtView` + detection live in `body.ts`; `CallRow` in `BodyEditor.tsx`.
  Gated by `test/system/system-body.test.ts` + e2e.
- **Add target context / module picker** — when a system has more than one
  bounded context (or module), the add toolbar shows an "Add into" picker so a
  new domain construct lands in the chosen context (and `api` references the
  chosen module), instead of always the first; repository / view reference an
  aggregate from that same context. The add path is now a pure, parse-guarded
  `add.ts` (`addConstructSource` / `addModuleSource` / `listContextNames` /
  `listModuleNames`), extracted out of the pane. Gated by
  `test/system/system-add.test.ts` + e2e.
- **Nested grouping + layout** — an opt-in **Group** toggle renders modules and
  bounded contexts as React Flow parent ("group") nodes, with member constructs
  laid out in a grid inside their context (modules become containers, so the flat
  module node is dropped and its edges remap to the group); infra / orphan
  constructs sit in a row beneath. The layout is a pure, deterministic
  `groupedLayout` in `grouped-layout.ts` (group boxes + parent-relative
  placements); flat column layout remains the default, and search / coverage /
  diagnostics still apply per leaf. Gated by
  `test/system/system-grouped-layout.test.ts` + e2e.

Open:

- **Edge rebinding by dragging** connections on the canvas — the drag gesture
  itself. Rebinding by inspector Select already exists for both single-reference
  constructs (`rebind.ts`) and multi-valued deployable references — modules /
  `serves` / ui (`deployable-bindings.ts`).
Planned — recommended order:

1. ~~**Finish expression/statement structuring**~~ — done: block-body lambdas,
   arg-name editing, and assignment-target structuring (all in Done above). Only
   structured *bare-call* statements remain (see Open) — low value, deferred.
2. ~~**Diagnostics on graph nodes**~~ — done (see Done above): per-construct
   error/warning outline + count, attributed by tightest CST containment.
3. ~~**Search / filter / focus**~~ — done (see Done above): search box + kind
   filter dim non-matches, with a Focus button. Neighbour-highlight on selection
   is the remaining nice-to-have.
4. ~~**Traceability overlay**~~ — done (see Done above): a Coverage toggle
   recolours the graph into a tested / untested / unreferenced heatmap from the
   enriched `traceability` index.
5. ~~**Apply-diff preview**~~ — done (see Done above): an opt-in Preview toggle
   stages each edit's source diff in a confirm modal before committing.
6. ~~**Wire-shape / DTO preview**~~ — done (see Done above): selecting an
   aggregate / value object shows its enrichment-computed `wireShape` in the
   inspector.

All six planned items are now done; the Open list above is the remaining backlog
(structured bare-call statements, drag-rebind, add target-context picker, nested
grouping, persisted positions).

Layout polish (slot in opportunistically): drag-to-rebind edges, persisted
positions, auto-layout (dagre/elk) + nested grouping, add target-context picker.
