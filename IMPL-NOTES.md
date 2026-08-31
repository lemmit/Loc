# IMPL-NOTES — wave2-macros-py-java handoffs

Findings and proposed changes that fall OUTSIDE this branch's trees
(`src/generator/python/**`, `src/generator/java/**`, `src/macros/**`). Nothing
here was applied; each entry names the file, the anchor, and the proposed code
so the owning agent can land it without re-deriving it.

---

## 1. `loom.scaffold-filter-param-unsupported` — the honest gate for the kinds the filter bar still drops

**Row:** `M-T1.15-nonstring-filter-finds-dropped` (the drop is now *narrower*, not
gone — see §2/§3 for why each remaining kind is held back).

After this branch, `filterFindsForAggregate`
(`src/macros/stdlib/scaffold/_body-builders.ts`) renders `string`, `int`, `long`
and `X id` filter params. A find carrying any OTHER param type is still dropped
**silently** — which is the shape the ledger row objected to. The honest gate:

**`src/diagnostics/messages.ts`** — add, keyed by the new code:

```ts
"loom.scaffold-filter-param-unsupported":
  "Scaffolded list filter bar: repository find '{find}' takes '{param}: {type}', " +
  "which has no filter input, so the find is omitted from the filter bar on " +
  "'{aggregate}'. Change the param to a string / int / long / <X> id, or write " +
  "the page body by hand.",
```

**`src/ir/validate/checks/ui-checks.ts`** — a new leaf check. It must run on the
IR (not the macro) so it sees the scaffolded page and the repository together.
Shape:

- for every `PageIR` classified as a list page (`classifyPage`, `src/ir/util/page-kind.ts`)
  whose aggregate has a repository,
- for every declared `find` with `returnType.kind === "array"` and ≥1 param,
- if the find is NOT referenced anywhere in that page's body, and every param's
  type is outside the renderable set, raise the diagnostic as a **warning**
  (an aggregate can legitimately carry finds the author never wanted in the bar,
  so an error would be wrong).

The renderable set must stay in one place. Suggest exporting the predicate from
`src/util/` (both layers may import it there) rather than duplicating the switch:

```ts
// src/util/filter-param-kinds.ts  (new; consumed by the macro AND the IR check)
export type FilterParamKind = "string" | "number" | "ref";
export const RENDERABLE_FILTER_PRIMITIVES = new Set(["string", "int", "long"]);
```

Mutation proof for whoever lands it: add `find byStatus(s: Status): Order[]` to a
scaffold fixture and assert the diagnostic fires; revert the check and assert it
does not.

---

## 2. ENUM filter params are blocked by the frontend state-type emitters, not by the macro

**Row:** `M-T1.15-nonstring-filter-finds-dropped` (enum arm).

> **Status 2026-08-31 (fleet wave 1, PR #2699):** `guid`, `datetime` and `bool`
> have since LANDED in the macro — `guid`/`datetime` bind the same string box as
> `X id` (both are `z.string()` on the request wire and `string` in every
> frontend's state emitter), and `bool` binds a three-state `SelectField`
> (`""`/`"true"`/`"false"`) passing `<state> == "true"` as the find argument,
> because a `Toggle`'s `false` zero value would put half the domain out of
> reach. **Enum is still blocked for exactly the reason below**, and this
> section is the frontend-js packet's brief: it is the LAST kind whose only
> obstacle is a frontend emitter.

The macro half of an enum filter is two lines (`SelectField` + the enum's values
as `options:`). It is **not landed** because the generated page would not
type-check:

- every frontend types an enum-typed `state {}` field as bare `string` —
  `stateTypeAsTsString` (`src/generator/svelte/walker/page-shell.ts:1034` and its
  React / Vue / Angular twins) has `if (type.kind === "id" || type.kind === "enum") return "string";`
- but the generated query param is the zod enum union —
  `src/generator/_frontend/api-module.ts` emits `s: StatusSchema` where
  `StatusSchema = z.enum(["Open","Closed"])`, i.e. `"Open" | "Closed"`.

So `useByStatusOrder({ s: byStatusS })` with `byStatusS: string` is **TS2322**,
and `generated-react-build` (and the Vue/Svelte/Angular twins) would go red.

Verified on this checkout, react + `--platform react`:

```
const [byStatusS, setByStatusS] = useState<string>("Open");   // Status state
const orderByStatus = useByStatusOrder({ s: byStatusS });     // s: StatusSchema
```

**Proposed fix (frontend trees — NOT this branch):** make the state emitters type
an `enum` state as the emitted enum union rather than `string`. Each frontend
already emits an enum type/schema next to the DTOs, so the change is to return
that name instead of `"string"` in `stateTypeAsTsString` and its twins, plus the
import. Once that lands, the macro side is:

```ts
// src/macros/stdlib/scaffold/_body-builders.ts — filterParamKind()
if (type.base.$type === "NamedType" && /* resolves to an Enum decl */) return "enum";

// …and in the bar emission:
p.kind === "enum"
  ? callExpr("SelectField", [
      { value: stringLit(humanize(p.name)) },
      { name: "bind", value: nameRefExpr(stateName) },
      { name: "options", value: /* listLit of the enum's value names */ },
      { name: "testid", value: stringLit(`${slug}-filter-${snake(stateName)}`) },
    ])
  : …
```

with the state field carrying the param's cloned `TypeRef` (the `typeRef` escape
hatch added to `StateFieldSpec` in `src/macros/api/ui-factories.ts` on this
branch already supports that) and the arm condition `<state> != ""`.

---

## 3. `decimal` / `money` filter params — Feliz's zero-literal comparison

> **Status 2026-08-31:** still held back, unchanged. Note the grammar DOES carry
> a `DecLit` (`ddd.langium` `LiteralExpr`), so a `decLit` ui-factory plus a
> Feliz-side numeric-literal check is a concrete route — it just needs the Feliz
> compile tier to verify, which is why wave 1 did not take it.

Held back for the same class of reason. The bar's "unset" sentinel is the int
literal `0`; F# types `model.ByRateR <> 0` as `decimal <> int`, which is FS0001.
Landing decimal needs either a decimal-literal factory in
`src/macros/api/ui-factories.ts` **and** a Feliz-side numeric-literal coercion, or
a per-target zero-literal seam. `money` additionally binds a `Decimal` state,
which `NumberField` does not accept at all.

---

## 4. PRE-EXISTING (not a regression): Feliz never wires a filter-find QueryView into the Elmish model

Found while verifying §2/§3 across all six frontends. On **fresh `main` behaviour**
(the plain `string` filter arm, which predates this branch), the scaffolded list
page on `platform: feliz` renders

```fsharp
(if (model.ByTitleT <> "") then (View.remoteList model.OrderByTitle …
```

but `OrderByTitle` is **never declared** on the model record, never initialised in
`init`, and no `Cmd` fetches it — `grep -n "OrderByTitle" web/src/App.fs` returns
exactly that one use site. So a scaffolded aggregate with ANY filter find fails to
compile on Feliz today, independent of this branch's change.

Repro: `scaffold` a context whose repository has `find byTitle(t: string): T[]`,
generate with `platform: feliz`, and read `web/src/App.fs`.

Owner: `src/generator/feliz/**`.

---

## 5. `provenanced-bare-read-in-page-body` — DEFERRED, both fix options are out of bounds

**Row:** `provenanced-bare-read-in-page-body` (P2, M). Re-verified as still open on
this checkout; not implemented here because **both** candidate fixes live in trees
this branch may not touch:

- fix (a), the better contract — auto-unwrap: one arm in the walker's member-access
  case (`src/generator/_walker/**`), keyed off the same `wireShape` carrier the
  api-type emitter reads, appending `PROVENANCE_VALUE_FIELD` when a page-body
  member access resolves to a `provenanced` field in a scalar/text position. HEEx
  already does exactly this in reverse (`src/generator/elixir/heex-walker-core.ts:63`
  imports `PROVENANCE_VALUE_FIELD` to DROP the hop), so the two engines would then
  agree for both spellings.
- fix (b), the gate — `loom.provenanced-bare-read` in
  `src/ir/validate/checks/ui-checks.ts` + `src/diagnostics/messages.ts`.

The macro half is already correct and needs no change: the scaffold appends the
hop at `src/macros/stdlib/scaffold/_body-builders.ts` (the two
`memberAccess(memberAccess(cellVar, name), PROVENANCE_VALUE_FIELD)` sites), which
is why scaffolded pages render and hand-written ones do not.

---

## 6. Java `document` repository dropped the in-app filter's expression imports (fixed here, noted for the census)

Not a handoff — landed on this branch — but worth a line because it was found
sideways and is the same silent class as the row it rode in on.

`src/generator/java/emit/document-store.ts` collected `collectJavaExprImports`
from the RAW `agg.contextFilters`. An `authz-filter` sentinel carries no
expression nodes, so a `policy { allow deep … }` tenant floor on a document
aggregate rendered `Objects.equals(...)` with **no `import java.util.Objects;`** —
the generated project did not compile. Imports are now collected from the
DESUGARED tree (`desugarAuthzFilterInApp`), same as the renderer sees. The
`errors-pointer-rfc6901` / `policy-write-scope-shapes` suites pin it.
