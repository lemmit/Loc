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
  serialize/craft path is unchanged. Block-statement lambda bodies stay Opaque.
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
  is a lambda (`Button(onClick: e => { … })`, form `onSubmit`) is kept as a
  verbatim passthrough prop — the carrying primitive stays recognised, the
  handler editable as raw source — instead of forcing Opaque; and a `ref` slot
  accepts a qualified ref (`Form(of: Sales.Order)`), surfaced as the current
  value in its dropdown.

## Open — expression / domain-logic surface

- **Statement-level handler editor** — event-handler / `onSubmit` bodies
  round-trip and are editable as raw source today; a structured editor for the
  statements inside (`:=`, `call`, `emit`, `navigate`, `let`) is a separate
  effort.
- **`state := …`** page state declarations / assignments. Not modelled.
- **Operation forms**: `Form(of:, op:)`, bound to aggregate operations — need op
  pickers wired to the IR (`Form` currently models only `of:`/`creates:`/`testid:`).
- **Richer bindings**: typed pickers for repository finds, view sources, enum
  values, and navigation params (qualified refs already round-trip).
- **`match` arm cond caveat** — the grammar misparses a *bare-identifier* arm
  cond (`ready => …`) as a lambda, so such conds must be comparisons/calls. Emit
  reproduces the original (valid) cond, so round-trip is safe; the "+ arm"
  control defaults the cond to `true` (a non-bare-ident expression).
- **`MasterDetail`/`Detail`** primitives, and calls to **user-defined
  components** (`component` defs) — the latter need per-component param signatures
  to map positional args to names.

## Open — editing UX

- **Drag-to-add** from the palette (today is click-add; craft's create-connector
  swallows the click). **Drag-reorder** across containers needs verification.
- **Diagnostics inside the Builder** (surface LSP errors/warnings on the canvas).
  Inline `expr`/Opaque `raw` validation already shows a non-blocking error in the
  settings panel; the canvas itself doesn't yet flag invalid nodes.
- **Mobile** Builder tab (desktop-only today).
- **Continuous text→canvas live sync** (today re-seeds on tab switch, not per
  keystroke) — needs debounce + canvas selection preservation.

Done: **component editing** (the body picker now lists `page` and `component`
bodies); **inline `expr`/`raw` validation** in the settings panel.

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
- **Editing**: select a node → see its printed source; **add** (module /
  aggregate) and **delete** splice the backing CST range via `edit-engine.ts`
  and write back through origin-tagged `onSourceChange` (Phase B sync). e2e:
  `web/e2e/system-builder.spec.ts`.
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
  (`web/src/builder/system/fields.ts`). Field *rename* is deliberately excluded
  (field-name refs in expressions/views resolve in IR lowering, not as Langium
  cross-references, so they can't be tracked). Gated by
  `test/system-fields.test.ts` + e2e.
- **Reference rebinding** — for single-reference constructs (repository → its
  `for` aggregate, api → its `from` module, view → its `from`/`=` aggregate) the
  inspector shows a Select that rewrites the reference's `$refNode` CST span; the
  graph edge re-derives on the next parse (`web/src/builder/system/rebind.ts`).
  Gated by `test/system-rebind.test.ts` + e2e.
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
  + member + an add/remove/edit argument list, and everything still unmodelled
  (lambdas, `match`, `new`, ternary, object literals) is a reparse-validated
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
  `where` filter through the same picker + editor (`repoSlotOptions`); finds with
  no `where` are omitted. Gated by `test/system-expr.test.ts` + e2e. (Editing
  find *params* is still open.)
- **Scope-aware name suggestions** — every `raw` leaf in the expression editor
  is an autocomplete fed the in-scope bare names (params, properties, derived
  props, helpers, enum values). The scope rules live in the IR: `inScopeNames`
  sits next to `Env`/`resolveNameRef` in `src/ir/lower-expr.ts`, and the web
  layer (`slotCandidates`/`slotEnv` in `expr-slots.ts`) reuses the IR's `Env`
  builders to construct the per-slot env exactly as `lower.ts` does — so the
  rules aren't forked. Gated by `test/system-expr.test.ts` + e2e.

Open:

- **Deeper expression structuring** — structured `match`/`new`/object
  literals/lambda (still `raw` leaves); **member-name completion** (suggesting
  `.member` after a receiver — needs the type system, not just the flat name set
  that drives bare-name suggestions today); and arg-*name* editing on calls
  (existing named args are preserved verbatim but can't be renamed in the UI).
- **Expression editor in more slots** — statement-expression slots
  (`let`/`:=`/`precondition` values inside bodies), reusing the same recursive
  editor (view filters/binds and repository find `where` clauses already done).
- **Field rename** — needs member-access reference resolution (via the
  type-system / IR) to update `this.field` / view binds safely.
- **Repository `find` editing** (params + where-clause expressions).
- **Edge rebinding by dragging** connections on the canvas (inspector-Select
  rebinding already exists — see above); plus multi-valued deployable references
  (module bindings, `serves`, ui) which the single-Select rebind doesn't cover.
- **Add** the remaining construct kinds (value object, event, repository, view,
  workflow, deployable, api, storage, ui), and choose the target context/module.
- **Nested grouping** (module → context → members as React Flow parent nodes)
  and auto-layout; today it's a deterministic column-per-kind layout.
- **Persisted positions** (layout is currently derived, not written back).
- **Mobile** Model tab (desktop-only today).
