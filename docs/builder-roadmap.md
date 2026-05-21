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

## Open — System / Model Builder (separate track, Phase C)

An editable `@xyflow` node-graph for the structural model (modules, aggregates,
value objects, events, repositories, deployables, storages, apis, uis +
relationships). Gated on a new **structural printer** (`src/language/print/
print-structural.ts`, with a corpus round-trip test) before any canvas work.
`@xyflow` is already available via the LikeC4 lazy chunk; the read-only LikeC4
viewer (`web/src/preview/`) is the visual reference. Reuse `web/src/builder/
edit-engine.ts` (`spliceNode`) to splice edited blocks.
