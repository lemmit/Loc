# UI / Page Builder — handoff notes

Handoff for whoever picks up the visual **Page Builder** (the craft.js canvas on
the playground's **Builder** tab). This documents what's built, how it's wired,
the non-obvious constraints, and what's open. It complements
`docs/builder-roadmap.md` (the canonical backlog) with implementation pointers.

All the work described here is **already merged to `main`** (PRs: Phase 1 MVP,
Phase 1b registry+bindings, Phase A container-with-props, Phase B two-way sync).
This branch only adds this note.

## What it is

The Builder tab lets you edit a `ui { page { body: … } }` page's `body:`
expression visually instead of by hand. It parses the live `.ddd` source, seeds
a craft.js canvas from the chosen page's body, lets you edit/drag/add primitives
and their props, and on **Apply** regenerates just that body and splices it back
into the source at the body expression's CST range. `.ddd` text stays the source
of truth — the canvas is a projection.

The page body DSL is the closed walker stdlib (`List`/`Detail`/`Form`/`Stack`/
`Heading`/`Button`/`Card`/`match`/lambdas/…) defined by the React body-walker
(`src/generator/react/body-walker.ts`); the Builder models a growing subset of
it and round-trips the rest verbatim.

## Architecture (the data flow)

```
.ddd source
  │  parseDdd (web/src/builder/parse.ts — main-thread Langium parser, no linking)
  ▼
page.body.expr (CallExpr AST)
  │  seedFromBody        (page/model.ts)   AST → BuilderNode tree (recognize-or-opaque)
  ▼
BuilderNode tree (craft-agnostic)
  │  toCraft             (page/serialize.ts)  → craft SerializedNodes
  ▼
craft.js <Frame> canvas  (page/PageBuilder.tsx + page/components.tsx)
  │  …user edits…  then Apply:
  │  fromCraft           (page/serialize.ts)  craft → BuilderNode tree
  │  emitBody            (page/model.ts)      BuilderNode → source string
  │  spliceNode          (edit-engine.ts)     replace body.expr's CST range
  ▼
ctx.onSourceChange(next, "builder")  → Monaco model + LSP + autogenerate (Phase B)
```

**Recognize-or-opaque is the core invariant.** A call whose shape exactly
matches a registered primitive becomes an editable typed node; *anything else*
(unmodelled calls, `match`, lambdas, args we don't model, non-canonical
positional-after-named arg order) becomes an `Opaque` node carrying its
`printExpr`-printed source verbatim. So the body **always** round-trips, and
regenerate-and-splice never corrupts the parts the canvas doesn't understand.

## Files

| File | Role |
|---|---|
| `web/src/builder/BuilderPane.tsx` | Bridge. Parses source, collects pages + `ref` option sets (aggregate names), seeds the canvas from the selected page, handles Apply (emit → splice → `onSourceChange`). Re-seeds via a `key={name:rev}` remount bump. |
| `web/src/builder/page/model.ts` | **The registry (`SPECS`) is the single source of truth** — it drives seed, emit, palette, and settings in lock-step. `seedFromBody` / `emitBody` / `propFields` / `defaultNode` / `isContainer` all read it. Edit this to add a primitive. |
| `web/src/builder/page/serialize.ts` | Adapter between the `BuilderNode` tree and craft's `SerializedNodes` map. Wraps the body in a synthetic non-emitted `Root` canvas (craft requires a canvas root; a body may be a leaf). `isCanvas` is keyed off `isContainer(name)`. |
| `web/src/builder/page/components.tsx` | The craft user-components (one per primitive) + resolver + palette. Containers render an `<Element canvas>` drop zone. |
| `web/src/builder/page/PageBuilder.tsx` | The Builder UI: craft `<Editor>`/`<Frame>`, page picker, palette, the **SettingsPanel** (renders editable fields from `propFields`: TextInput / NumberInput / Select-for-ref / Textarea-for-raw), Apply button. |
| `web/src/builder/edit-engine.ts` | Shared splice engine (`spliceNode`, `nodeEditRange`, `applyEdits`) — also used by the Model builder. |

## The registry (`SPECS`) — how to add a primitive

Each entry is `{ kind: "container" | "leaf", positional?: string[], named?: NamedProp[] }`.

- **leaf** — carries only props (positional strings + named typed args), no children. e.g. `Heading`, `Text`, `Button`, `List`, `Form`.
- **container** — holds child nodes, and *may also* carry leading scalar props (Phase A): `Card` (positional `title`), `Container` (named `size`), `Paper` (named `padding`). Positional props are peeled greedily from leading **literal** args; the first non-literal begins the children (mirrors the walker's title-vs-content heuristic at `body-walker.ts` ~`renderCard`).
- **NamedProp** `kind`: `"string"` (quoted on emit), `"int"`, or `"ref"` (a bare identifier — drives a Select populated from an option set, e.g. `options: "aggregate"`).

Because the registry drives everything, adding a recognised primitive is usually
just a `SPECS` entry **plus** a craft component in `components.tsx` (+ resolver/
palette registration). Add a `builder-page-model` round-trip test (seed→emit) and
extend the e2e.

## Two-way sync (Phase B)

Builder edits flow back to Monaco + LSP so the source tab and Problems panel
update immediately, with no echo loop:

- `web/src/layout/ctx.ts` — `onSourceChange(text, origin?: "editor" | "builder")`.
- `web/src/App.tsx` — when `origin !== "editor"`, pushes the text into the editor handle (`editorHandleRef.setSource`) in addition to updating `sourceRef`/VFS/autogenerate.
- `web/src/editor/LoomEditor.tsx` — exposes `setSource` via imperative handle; it uses a full-range `pushEditOperations` (preserves undo, unlike `setValue`), guarded by a `suppressDispatch` ref so the programmatic edit re-runs the LSP but does **not** re-dispatch `onSourceChange` (which would loop). The canvas re-seeds from current source on tab activation (BuilderPane mounts only while the tab is active).

## Tests

- `test/builder-page-model.test.ts` — seed/emit round-trip over representative bodies (the anti-drift gate; mirrors how the structural printer is gated).
- `web/e2e/builder-page.spec.ts` — Playwright: open an example, edit a primitive/nested element, Apply, assert source round-trips + stays valid.
- Run: `npm test` (unit), `cd web && npx playwright test builder-page` (e2e), `cd web && npm run typecheck && npm run build`.

## Gotchas

- **Canonical arg order only.** A positional arg after a named arg can't be
  re-emitted faithfully → the node falls back to Opaque (`partition` in
  `model.ts`). Emit always puts positionals (incl. container scalar props)
  before named args to stay canonical.
- **`ref` props model only bare identifiers.** Qualified refs (`Sales.Order`)
  fall back to Opaque (`readNamed`).
- **`STRING` terminal strips delimiters** — re-quote on emit with
  `JSON.stringify` (already handled in `emitBody`/`emitNamed`).
- **craft root must be `"ROOT"` and a canvas** — hence the synthetic `Root`
  wrapper that is never emitted.
- **Re-seed on Apply** is a `key` remount (`BuilderPane` `key={name:rev}`), so
  craft state resets cleanly to the new source.

## Open work (see `docs/builder-roadmap.md` for the full list)

The big gap is the **expression / domain-logic surface** — the printer
round-trips it (so it's safe as Opaque) but there's no UI to edit it:

- `match(expr) { case … }` — needs a node with editable scrutinee + per-case child canvases.
- **Lambdas** — `List(of: X, x => Detail(x.field))`, form field render closures — need lambda-param scope + a body child canvas.
- `state := …` page state.
- **Expression-valued args** — a settings field that parses + validates a typed expression (member access, calls, literals), not just string/int/ref.
- **Operation forms** — `Form(of:, op:)`, `Modal(trigger:, Form(of:, op:))` bound to aggregate operations (op pickers wired to the IR).
- **More primitives** — `Tabs`/`Tab`, `MasterDetail`, `Detail`, `Table`/`Column`, `Stat`, `Money`, inputs (`Field`/`NumberField`/…), user-defined `component` calls.
- **Editing UX** — drag-to-add from palette (craft create-connector swallows the click today; click-add is the workaround), drag-reorder verification, add-child affordance on a selected container, in-canvas diagnostics, mobile Builder tab, continuous text→canvas live sync (today re-seeds on tab switch, not per keystroke).

## Relationship to the Model builder

A separate **Model** tab (`web/src/builder/system/`) edits the *structural*
model (a React Flow graph: modules/aggregates/VOs/events/…). It shares
`edit-engine.ts` and the same regenerate-and-splice + origin-tagged
`onSourceChange` philosophy, but is otherwise independent (different printer:
`src/language/print/print-structural.ts`). Don't conflate the two — the Page
Builder owns page `body:` expressions; the Model builder owns construct
declarations and their fields. Coordinate only via `edit-engine.ts` and
`ctx.onSourceChange`.
