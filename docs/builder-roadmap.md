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

## Open — expression / domain-logic surface (the big gap)

The expression/statement **printer already exists** (`src/language/print/
print-expr.ts`, `print-stmt.ts`) and the Opaque fallback uses it, so logic
*round-trips* — but the canvas has no UI to *edit* it. To make it editable:

- **`match(expr) { case … }`** — conditional UI. Currently Opaque. Needs a node
  type with editable scrutinee + per-case child canvases.
- **Lambdas** — e.g. `List(of: X, x => Detail(x.field))`, form field render
  closures. Currently force the whole call to Opaque. Needs lambda-param scope +
  a child canvas for the body.
- **`state := …`** page state declarations / assignments. Not modelled.
- **Ad-hoc expression-valued args** — a settings field that parses a typed
  expression (member access, calls, literals) and validates it, instead of only
  string/int/ref props.
- **Richer bindings**: qualified refs (`Sales.Order` — today only bare idents are
  modelled), repository finds, view sources, enum values, navigation params.
- **Operation forms**: `Form(of:, op:)`, `Modal(trigger: Button(…), Form(of:, op:))`
  — bind to aggregate operations; need op pickers wired to the IR.
- **Non-canonical arg order** currently → Opaque; could normalise on emit.

## Open — primitive coverage

Not yet modelled (fall back to Opaque). From `STDLIB_LAYOUT_COMPONENTS` in
`src/generator/react/body-walker.ts`:

- Layout/containers: `Tabs` (+ `Tab` sub-primitive), `Breadcrumbs`, `Skeleton`,
  `Modal`, `MasterDetail`, `Detail`.
- Display: `Stat`, `Money`, `DateDisplay`, `EnumBadge`, `IdLink`, `Image`,
  `Avatar`, `Loader`, `KeyValueRow`, `Table` (+ `Column`), `QueryView`.
- Inputs (inside forms): `Field`, `NumberField`, `PasswordField`, `Toggle`.
- `Slot`, and calls to **user-defined components** (`component` defs).

## Open — editing UX

- **Drag-to-add** from the palette (today is click-add; craft's create-connector
  swallows the click). **Drag-reorder** across containers needs verification.
- **Add-child affordance** directly on a selected container (today: palette adds
  into the selected container).
- **Diagnostics inside the Builder** (surface LSP errors/warnings on the canvas).
- **Inline validation** of the Opaque `raw` source field.
- **Component / multi-page editing** — edit `component` bodies and switch pages
  beyond the current page picker.
- **Mobile** Builder tab (desktop-only today).
- **Continuous text→canvas live sync** (today re-seeds on tab switch, not per
  keystroke) — needs debounce + canvas selection preservation.

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

Open:

- **Rename** a construct (and update all references — repo `for`, `Id<X>`,
  `from`, deployable bindings — not just the declaration).
- **Inline field editing** (aggregate properties, event fields, repo finds)
  rather than a read-only source view; reuse the structural printer to reprint
  the changed node from a mutated AST.
- **Edge creation / rebinding** by dragging connections (e.g. point a repository
  at a different aggregate, bind a deployable to a module).
- **Add** the remaining construct kinds (value object, event, repository, view,
  workflow, deployable, api, storage, ui), and choose the target context/module.
- **Nested grouping** (module → context → members as React Flow parent nodes)
  and auto-layout; today it's a deterministic column-per-kind layout.
- **Persisted positions** (layout is currently derived, not written back).
- **Mobile** Model tab (desktop-only today).
