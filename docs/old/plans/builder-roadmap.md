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
  Data-bound display args (`Badge { order.status }`, `Stat { "Total", order.total }`)
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
  *named* — `QueryView { loading:/error:/empty:/data: }`, `Table {onRowClick:/
  rowTestid:}` callbacks, `Modal { trigger: }`. Seeded as `slot`-tagged children
  (flat children, no craft `linkedNodes`); the slot survives craft's
  `SerializedNodes` round-trip via a reserved `__slot` prop. `data:` lambdas
  nest a `Lambda` body child, so a `QueryView { data: rows => Table { … } }` is
  editable all the way down.
- **Arbitrary arg order**: a node records its source arg order (an `order`
  token list of prop keys + child markers, persisted via a reserved `__order`
  prop) and `emitBody` replays it, so a positional after a named arg — the
  common hand-written `Table { rows: x, Column { … }, Column { … } }` — round-trips
  instead of falling back to Opaque. Replay is edit-safe: children are pulled in
  array order, and children/named props added after seed are appended; fresh
  palette nodes (no recorded order) still emit in canonical order.
- **Passthrough modifiers + optional args**: an unmodelled named arg
  (`testid:`/`striped:`/`gap:`/…) is kept as a verbatim passthrough prop —
  editable as a generic expr field, surfaced in the settings panel — instead of
  collapsing the node to Opaque; and declared positionals are optional from the
  right (`Empty {}` is recognised). See also event-handler lambdas, below.
- **Expression-valued text**: text content (`Heading`/`Text`/`Button`/`Anchor`/
  `Alert`/`Empty`) is a `text` kind — a plain text box for a string literal,
  the raw expression otherwise — so `Text { "Hello, " + name }` is editable rather
  than Opaque.
- **In-canvas add-arm / add-child**: a selected `Match` shows "+ arm"/"+ else"
  controls (arms aren't palette primitives); the palette won't drop a raw
  primitive into a Match or an already-full single-child slot.
- **Event-handler lambdas + qualified refs**: an unknown named arg whose value
  is a lambda (`Button { onClick: e => { … } }`, form `onSubmit`) becomes an
  editable slot child — a `Lambda` node (with the statement-row editor for block
  bodies), rendered nested inside the carrying primitive (leaves render their
  slot children too) — instead of a raw passthrough string or Opaque; and a
  `ref` slot accepts a qualified ref (`Form { of: Sales.Order }`), surfaced as the
  current value in its dropdown.
- **User-component calls**: a call to a user-defined `component` (collected
  from the source with its param names, registered in the craft resolver) is
  recognised, its positional args modelled as props **labelled by the declared
  param name**. A non-component value call (`format(x)`) stays an expression.
  *(The `Detail`/`MasterDetail` archetypes once recognised here were removed —
  [D-NO-PAGE-ARCHETYPES](../../decisions.md#d-no-page-archetypes); the list/detail
  surface is the `scaffoldList`/`scaffoldDetails` sentinels.)*
- **Typed binding pickers**: `Form { op: }` is a dropdown of the bound `of:`
  aggregate's operations (contextual — it follows the selected `of:`);
  `Form { runs: }` lists workflows. Aggregate/workflow/view option sets are
  collected from the source (`BuilderPane`); `op:` is contextual via the
  per-aggregate operations map.  A boolean-valued modifier (`striped: true`)
  edits as a switch, and `color:` (Badge/Alert) is a palette dropdown.
- **Statement-level handler editor**: a block-bodied lambda (any named-arg
  handler — `Button { onClick: }`, form `onSubmit`, `Table { onRowClick: }`) seeds as a
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
  verbatim fallback row (bare calls / anything unmodelled) now reparse-validates
  and flags an "Invalid statement". (`emit` isn't a page-handler statement —
  it's domain-side, edited in the system/workflow builder.)
- **Structured `navigate(…)` statement**: a `navigate(<page>, <params?>)` bare
  call in a handler block seeds as a structured `Stmt` row — a **target-page
  picker** (dropdown of source-collected page names) plus an optional
  reparse-validated **params** expression — mirroring the `let`/assignment
  structuring (`seedStmt`/`emitBody` in `web/src/builder/page/model.ts`, settings
  panel in `PageBuilder.tsx`). A non-NameRef first arg (very rare) falls through
  to the verbatim bare row so round-trip stays safe. Object-literal params
  (`{ id: order.id }`) aren't supported — object literals don't parse in page
  expression position (only domain bodies admit them) — so params is a single
  positional expression; users wanting object-literal route params hand-write
  the bare statement. `navigate(…)` in *expression* position (e.g. inside an
  `Action(then: …)`) stays out of reach until `Action` is structurally
  recognised (it currently round-trips as Opaque).
- **Enum-case default picker**: in the State panel, an enum-typed state field's
  default renders as a dropdown of the enum's cases (collected from the source by
  `BuilderPane`; the current value is always selectable so a hand-written default
  isn't clobbered) instead of a free-text input.
- **Enum-case picker for assignment values**: a structured assignment row whose
  target is a *bare-identifier* matching an enum-typed state field renders its
  value cell as a dropdown of that enum's cases (current value always selectable;
  fall-through to the validated free-text textarea otherwise). Per-position type
  inference is intentionally bounded — only bare-ident assignment targets of an
  enum-typed `state {}` field. Member-access targets (`draft.status`), non-state
  idents, and non-enum types stay as free text (no full type pass). Predicate-arm
  `match` conds aren't covered: the grammar's `match` carries no scrutinee, so a
  single-position picker doesn't fit there. Helpers: `enumStateFields` /
  `expectedAssignEnum` in `web/src/builder/page/model.ts`; wired through
  `BuilderPane` → `PageBuilder` → the assign-row settings. Gated by
  `test/generator/builder-page-model.test.ts` and `web/e2e/builder-page.spec.ts`.
- **`match` arm cond enum picker (Model tab)**: in the structured expression
  editor, a `match` arm cond shaped `<expr> == <expr>` / `<expr> != <expr>`
  whose one operand types as an enum renders the other operand's raw leaf as a
  Mantine `Select` of the enum's cases (current value always selectable;
  fall-through to the existing Autocomplete otherwise). Reuses `typeOf` +
  `envForNode` from `src/language/type-system.ts` and `membersOfType`'s enum
  case enumeration — no parallel resolver. Path scheme mirrors `memberCandidates`
  exactly so the editor's leaf lookup hits the right slot. Caveat: covers the
  top-level `lhs == EnumCase` / `lhs != EnumCase` shape; nested conjunctions
  (`a && b`), set-membership, and reverse-direction `EnumCase == lhs` (where
  only the LHS is a bare case name, which `envForNode` doesn't resolve) fall
  through to free text. Helpers: `enumPickerCandidates` in
  `web/src/builder/system/expr-slots.ts`; threaded through `SystemBuilderPane`
  → `ExprSlotEditor` via the new `EnumPickerCandidatesContext`. Gated by
  `test/system/system-expr.test.ts` and `web/e2e/system-builder.spec.ts`.
- **Mobile Builder + Model tabs**: both builders have a narrow-viewport layout —
  full-width canvas, palette/settings (page) and inspector (model) move into
  bottom drawers, reached via the consolidated Code tab's SegmentedControl
  (`PageBuilder.tsx` / `SystemBuilderPane.tsx`, `ctx.isDesktop`). Gated by
  `web/e2e/mobile-builder.spec.ts`.
- **Continuous text→canvas live sync**: a debounced (~350ms) re-seed wired off
  a new `ctx.editorSourceTick` counter (bumped only on `origin === "editor"`
  edits — builder Apply doesn't echo-loop). BuilderPane now stays mounted via
  a display toggle (same pattern the editor uses) so a tab switch doesn't tear
  craft state down, and a `<LiveSync>` child inside the craft `<Editor>`
  captures the active selection's **structural path** (chain of child indices
  through the body tree), calls `actions.deserialize(seed)` in-place, and
  re-selects the node at the same path in the new seed; an unresolvable path
  (the source change moved or removed that node) clears the selection rather
  than erroring. Pure `findNodeAtPath` / `pathOfNode` helpers in
  `web/src/builder/page/live-sync.ts`; gated by
  `test/generator/builder-page-live-sync.test.ts` and two e2es in
  `web/e2e/builder-page.spec.ts` ("live sync — …").

## Open — expression / domain-logic surface

- **Per-statement structure** — assignment, `let`, and `navigate(…)` are
  structured (see Done above); other bare calls keep a validated single-row
  editor (a call is one expression, so structuring buys little beyond the
  validation now in place).
- **`match` arm cond caveat** — the grammar misparses a *bare-identifier* arm
  cond (`ready => …`) as a lambda, so such conds must be comparisons/calls. Emit
  reproduces the original (valid) cond, so round-trip is safe; the "+ arm"
  control defaults the cond to `true` (a non-bare-ident expression).

## Open — editing UX

Done: **Continuous text→canvas live sync** — see Done above (debounce + path-
keyed selection preservation, BuilderPane kept mounted via display toggle).

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
- **Rename** a construct *and every reference to it* (repo `for`, `X id` part
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
  body's scope suggestions), `Part { … }` and object literals `{ … }` render
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
  `X id`/optional unwrapped). The single source of truth is `membersOfType` in
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
  including `balance := Money { … }` and `emit E { f: <expr> }` — are editable with
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
  kinds keep their single text row. The op is a `:=` / `+=` / `-=` dropdown.
  - **Typed target + inline structured expressions** — the target is now an
    `Autocomplete` over the owning aggregate's assignable property names (still
    accepts a dotted path, so it's non-lossy); and a per-row `ƒx` toggle expands
    a statement's expression into the same structured `ExprSlotEditor` the
    Expression picker uses, bound to that statement's slot (`stmtExpr` / `wfStmt`,
    with an optional `field`). It covers every editable body expression — the
    **assignment value**, the single-expression statements (`precondition` /
    `requires` / `let`), each **bare-call argument** (`field` = arg index), and
    each **emit field** value (`field` = field index) — editing just that
    expression and leaving the keyword (and a `let` binding's name) in source.
    `emit` also splits into its event (a label — repoint via the Emits picker)
    plus add/delete `name: value` fields. A bare call's **head** is an
    `Autocomplete` over in-scope receiver names (`slotCandidates` — params,
    earlier lets, this-props / context); still free text, so the `.method` part
    and any path are unrestricted. Keyed by `rev` so it re-seeds on commit; the
    open row is held in the pane so it survives. A `hasValueEditor` predicate
    decides which rows / args / fields get the toggle. Gated by
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
- **Edge rebinding by dragging** — dragging a (reconnectable) edge's target
  endpoint onto another node repoints its reference, reusing `rebindReference`
  (or `setDeployableTargets` for the `targets` edge). Scoped to the four single,
  unambiguous cross-ref edges: a repository's `for` aggregate, a `from` source
  (view→aggregate, api→module), and a deployable's `targets` deployable; the
  owner (edge source) is fixed and an incompatible drop / unparseable rewrite is
  rejected. Pure `isRebindableEdge` / `rebindEdgeTarget` in `edge-rebind.ts`;
  wired via React Flow `onReconnect` (`reconnectable: "target"` on those edges,
  off in grouped mode). Gated by `test/system/system-edge-rebind.test.ts`. (The
  drag *gesture* isn't e2e-covered — hard to script reliably; the rebind logic
  is.)
- **Mobile layout pass** — on a compact viewport the inspector is a bottom
  drawer opened via the "Inspect / +" button, which used to sit top-right and
  collide with the canvas overlay toolbar (search / toggles wrap full-width on a
  phone). Moved it to a bottom-right floating button (filled + shadow), clear of
  the overlay and thumb-reachable. Gated by `web/e2e/mobile-model-builder.spec.ts`
  (a 390×844 viewport asserting the FAB sits below the overlay and opens the
  drawer) — the first phone-viewport e2e for the builder.

Open:

- **Drag-rebind for deployable `ui`** — a single ref too, but `setDeployableUi`
  is form-sensitive (it would convert a compose/block form to sugar), so it
  stays inspector-only for now.
- **Multi-valued / derived edges** (`deployable` modules / `serves`, `emits`)
  are inherently not single-drag rebindable — they stay inspector / statement
  editors.

## Model builder v2 (drill-down React Flow)

v1 is the existing "Model" tab; v2 is being built in `web/src/builder/system-v2/`
behind a separate "Model v2" tab in both shells. v1 stays untouched and
shippable until v2 reaches parity (Phase 4); they coexist meanwhile.

The shape: the canvas is the navigator. You drill down through Loom's hierarchy
(system → module → context → aggregate → operation) via double-click / a "↳"
handle, and back up via a breadcrumb. The leaf — an operation or workflow — is
a vertical React Flow of statement nodes, each embedding the existing inline
`ƒx` editors from v1. Expression-as-flow stays deferred (wait-and-see; the
architecture accommodates it later without rework).

Phasing:

- ~~**Phase 0** — skeleton tab + wiring.~~ Done: lazy-loaded
  `SystemBuilderV2Pane` mounts under "Model v2" in DesktopShell + MobileShell;
  reads `ctx.getSource()` and shows top-level construct counts as proof of
  flow. Gated by `web/e2e/system-builder-v2.spec.ts`.
- ~~**Phase 1** — drill-down backbone (read-only).~~ Done: a pure per-level
  `buildViewGraph(ast, path)` in `system-v2/view-graph.ts` walks the AST for
  each level (root / system / module / context / aggregate); the pane wraps it
  with a clickable breadcrumb and a React Flow whose nodes drill on click for
  drillable kinds (system / module / context / aggregate / operation /
  workflow). Empty path = root, clicking the Model crumb pops back. Operation
  and workflow leaves render as empty placeholders — Phase 2 fills them in.
  Gated by `test/system-v2/view-graph.test.ts` (per-level unit snapshots) +
  `web/e2e/system-builder-v2.spec.ts` (drill system → module → context →
  aggregate, then pop home).
- ~~**Phase 2a** — operation / workflow flow view (read-only).~~ Done: an
  operation / workflow leaf renders as a vertical column of `stmt` nodes
  connected by implicit "next" edges; each node uses a custom `StmtNode`
  React Flow type, kind-tinted (assign / call / emit / other) with monospace
  text. Reuses `body.ts`'s `listStatementViews`. Gated by
  `test/system-v2/view-graph.test.ts` (operation / workflow snapshots) +
  `web/e2e/system-builder-v2.spec.ts` (drill into `Order.confirm`, see stmt
  nodes incl. the `emit`).
- ~~**Phase 2b** — editable stmt nodes (inline rows).~~ Done: v1's
  `AssignRow` / `CallRow` / `EmitRow` / `OtherRow` are now exported and
  embedded inside `StmtNode`, with the inline `ƒx` editor wired through the
  same `slotExpr` / `slotCandidates` / `editExprSlot` / `exprHints` helpers
  as v1. The pane carries a `rev` counter so each commit re-parses, re-builds
  the view-graph, and re-binds the per-stmt handlers; switching to a
  different leaf collapses any open `ƒx`. `.nodrag .nopan` on the node lets
  inputs / dropdowns work inside the React Flow node. Gated by the v2 e2e
  (asserts each stmt kind's editor controls are present inside the node).
- ~~**Phase 3a** — per-view add palette.~~ Done: a small toolbar above the
  canvas exposes the adds appropriate to the current drill level — `+ Module
  / + API / + Storage / + UI / + Deployable` in the system view, and `+
  Aggregate / + Value object / + Event / + Workflow / + Repository / + View`
  in the context view (target context auto-derived from the path). Reuses
  v1's parse-guarded `addConstructSource` / `addModuleSource`. Gated by the
  v2 e2e (system + context palette add bumps the relevant node count).
- ~~**Phase 3b** — rename + delete on the node.~~ Done: a new `ConstructNode`
  custom React Flow type replaces the default node for non-stmt constructs,
  with an on-node pencil (inline rename input, commits via v1's
  `renameConstruct`) and an `×` (delete via `spliceNode` on the construct's
  AST node). Wired for every ViewKind that v1's NodeKind already covers —
  module / aggregate / valueobject / event / repository / view / workflow /
  api / storage / ui / deployable. System / context / operation / field /
  containment still render without action buttons in this phase. Gated by the
  v2 e2e (rename Order → OrderX on the canvas, then delete it; counts +
  data-construct-name reflect the changes).
- ~~**Phase 3c (palette additions)** — module / aggregate / operation
  palettes.~~ Done: new pure helpers `addContextSource` (insert a context
  into a module) and `addOperationSource` (insert an operation into an
  aggregate) in `system-v2/add-extra.ts`; the palette gains `+ Context` in
  the module view, `+ Operation` + `+ Field` (reusing v1's `addField`) in
  the aggregate view, and `+ Stmt` (a `precondition true` via v1's
  `addStatement`) in the operation / workflow flow view. Gated by
  `test/system-v2/add-extra.test.ts` + the v2 e2e (each palette adds bumps
  the relevant node count by one).
- ~~**Phase 3d — rename / delete for the remaining ViewKinds.**~~ Done: a new
  `renameByAstType` helper (mirrors `renameConstruct` but keyed directly on
  `$type`, not v1's NodeKind union) lets v2 rename `System` / `BoundedContext`
  / `Operation` / `FunctionDecl` too, with the same NameProvider + References
  rewrite as v1. Delete already worked by `$type`. Now every named construct
  except `field` and `containment` (which need `renameMember`'s text-token
  resolver — left for Phase 4) gets the pencil + `×` affordance on its node.
  Gated by the v2 e2e (rename a context and delete an operation through the
  on-node controls).
- ~~**Phase 4a — field rename + delete on the node.**~~ Done: routes through
  v1's `renameMember` (text-token resolver, handles `this.field` / `x.field`
  usages via the shared `member-refs` resolver) and `deleteField` (preserves
  surrounding layout); containment also gets rename. Gated by the v2 e2e
  (rename + delete a field on the canvas).
- ~~**Phase 4b (emit-event repointing).**~~ Done: an emit stmt node's event
  is a `Select` over every `EventDecl` in the model; on change v2 calls v1's
  `setEmitEvent` (rewrites just the event reference token, parse-guarded).
  `EmitRow` gained two additive props (`events` + `onRepointEvent`) — when
  unset it renders the old dimmed label, so v1 is unaffected. Gated by the
  v2 e2e (repoint `Order.confirm`'s emit from `OrderConfirmed` to
  `LineAdded`).
- ~~**Phase 4c (deployable bindings as edges).**~~ Done: the system view now
  draws an edge per deployable binding — `deployable -modules-> module`,
  `deployable -serves-> api`, `deployable -ui-> ui`, `deployable -targets->
  deployable` — pulled from v1's `deployableModules` / `deployableServes` /
  `deployableUi` / `deployableTargets`. Read-only visualisation; editing the
  bindings inline is Phase 4d. Gated by `test/system-v2/view-graph.test.ts`
  (a system with `api` + `webApp` produces the expected modules / serves /
  targets / ui edges).
- ~~**Phase 4d (drag-rebind `targets` / `ui`).**~~ Done: the system view's
  `targets` and `ui` edges are now `reconnectable: "target"` and the v2 pane
  has an `onReconnect` handler that dispatches through a new pure helper
  `rebindDeployableEdgeTarget` (wraps v1's `setDeployableTargets` /
  `setDeployableUi`, rejects wrong target kinds, self-targets, and the
  multi-valued labels). The multi-valued bindings (`modules` / `serves`)
  intentionally stay non-drag — they need a multi-select UI. Gated by
  `test/system-v2/deployable-edge-rebind.test.ts` (5 cases). The drag gesture
  itself isn't e2e-covered for the same reason v1's drag-rebind isn't —
  React Flow reconnect-anchor drags are fragile in Playwright.
- ~~**Phase 4e (multi-valued deployable bindings inline).**~~ Done: deployable
  nodes now embed a `modules` and a `serves` Mantine `MultiSelect` (when its
  bindings panel data is provided), backed by v1's `setDeployableModules` /
  `setDeployableServes`. `ConstructNode` widens to ~240 when multi-selects
  are present so the chip pills fit. With this, every binding on a deployable
  is editable on the canvas — targets / ui by drag (Phase 4d), modules /
  serves by multi-select. Gated by the v2 e2e (the api deployable in Banking
  System exposes both multi-selects on its node).
- ~~**Phase 4f (repository finds as drillable nodes).**~~ Done: repository
  becomes drillable; the new repository view lists each `FindDecl` as a
  `find` ViewKind node — same on-node rename / delete (via
  `renameByAstType("FindDecl")` + spliceNode). Inline filter editing is a
  follow-up (`findFilter` slot already exists). Gated by
  `test/system-v2/view-graph.test.ts`.
- ~~**Phase 5a (mobile pass).**~~ Done: `compact` (= `!ctx.isDesktop`) is
  threaded into the v2 node data; `StmtNode` shrinks to 320px and the
  `ConstructNode` multi-select panel to 210px on a phone-width canvas so
  nothing overflows. Gated by a new
  `web/e2e/system-builder-v2-mobile.spec.ts` (390×844 viewport drills
  Sales System → Order → confirm and confirms the statement flow renders).
- ~~**Phase 6 (visual kick — invariants + substatement subkinds).**~~ Done:
  aggregate view now surfaces each `Invariant` as a node (id keyed by index,
  name = a preview of the expression) — delete works through the parent
  aggregate by index. And in the statement flow, "other" stmt rows are
  discriminated by their leading keyword: `precondition` (yellow),
  `requires` (orange), `let` (cyan), or generic `stmt` (gray) — each with
  its own label + border tint instead of the uniform `STMT`. Gated by the
  v2 e2e (banking invariants render; Order.confirm's precondition shows
  `data-stmt-subkind="precondition"`).
- ~~**Phase 7 (inline expression editor for invariants + find filters).**~~
  Done: a shared `buildExprToggle` in the v2 pane builds an `ExprSlotEditor`
  + toggle for any slot; `ConstructNode` exposes an optional `ƒx` button +
  expanded editor section. Wired for **invariants** (`{kind:"invariant",
  owner, index}`) and **repository find filters** (`{kind:"findFilter",
  owner, name}`) — same scope-aware completion as v1's Expression picker
  for these slots. Node widens to 320/360px while the editor is open. Gated
  by the v2 e2e (Banking invariant `ƒx` opens an editor; Acme repository
  find filter `ƒx` opens an editor).
- ~~**Phase 8 (per-view persisted node positions).**~~ Done: construct
  nodes are now draggable, and their final position is written to
  localStorage under `loom-v2-pos-${pathHash}` keyed by node id on
  `onNodeDragStop`. The pane re-reads the per-view map whenever the
  breadcrumb path changes, and the `toRfNodes` boundary overlays any
  persisted entry onto the pure-computed `view-graph` layout — so drags
  survive source edits + reloads. Stmt rows (auto-laid flow column) and
  the root banner are excluded. A "Reset layout" overlay button (behind a
  `confirm`) clears the current view's entries. Gated by
  `test/system-v2/persisted-positions.test.ts` (pure-helper unit tests)
  and the v2 e2e (drag → reload → restored → reset → derived).
- **Phase 5** — polish: search / coverage / grouped layout adapted per zoom
  level, mobile passes. ~~Transitions on drill~~ done: drilling in/out animates
  the React Flow viewport — `setCenter`-toward-clicked-node (~200ms) followed
  by `fitView({ duration: 250 })` on the new view; breadcrumb jumps animate
  the fit only. `prefers-reduced-motion` skips the animation.

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
grouping).

Layout polish (slot in opportunistically): drag-to-rebind edges, auto-layout
(dagre/elk) + nested grouping, add target-context picker.

## Playground LSP — multi-file workspace ✓

**Done.** The browser-hosted Langium LSP now sees every workspace `.ddd`
source, not just the active editor model.

  - `web/src/lsp/workspace-lsp-sync.ts` subscribes to the
    `WorkspaceSourcesController` and creates a Monaco model for every
    `.ddd` in `/workspace/`. `MonacoLanguageClient`'s
    `documentSelector: ["ddd"]` then auto-sends `textDocument/didOpen` and
    `didChange` per model, putting every file into the LSP's global scope
    — cross-references between aggregates / value objects / enums across
    files resolve.
  - URI scheme unified: `LoomEditor.modelUriFor` dropped its
    `inmemory:///main.ddd` special case in favour of the consistent
    `inmemory:///workspace/<path>`. Both the editor and the sync layer
    now produce identical URIs for the same file, so a single Langium
    document is registered (no phantom ambiguity errors).
  - Active-file model is left to `LoomEditor` (avoid `setValue` racing
    with user edits); inactive files are kept in lock-step with the VFS
    by the sync layer.

Multi-file example (`examples[0]`, "Multi-file project (root-level shared
types)") opens clean with `0 errors`. The default cold-boot landing stays
on **sales-system** because the mobile-requirements e2e specs hard-code
US-001 / SOL-001 row IDs that only live there.
