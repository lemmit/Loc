# Generated-code review — 2026-06-30

A read-through of the **generated output** (not the emitters in the abstract) for
every backend and frontend, looking for code that is *clearly out of place* —
real logic bugs, dropped declarations, leaked placeholders — rather than style.
(Companion to the earlier `generated-code-review-2026-06.md`; this is a fresh
fresh-`main` snapshot on the date above.)

**Method:** `generate system examples/showcase.ddd` (exercises all 5 backends +
3 frontend packs) into a scratch tree, then one focused reviewer per target
comparing generated source against the `.ddd` spec and the emitter. Spot-checks
of the event-sourcing / inheritance / persistence-shapes systems as well.

**Headline:** `.NET` and `Java` output is clean. **Two genuine bugs, both
Elixir-only and both compile-clean** (so `elixir-vanilla-build` / `mix compile`
cannot catch them — they are silent runtime defects). Plus two minor
consistency nits.

---

## 🔴 BUG-1 · Enum comparisons are always-false in Elixir domain code

- **Where (output):** `phoenix_api/lib/phoenix_api/builds.ex` — `passed/1`:
  ```elixir
  def passed(%Build{} = record), do: record.build_state == "passed"
  ```
- **Where (root cause):** `src/generator/elixir/render-expr.ts:331` renders an
  `enum-value` ref as a **string** literal (`"passed"`).
- **Why it's wrong:** the schema emits the column as
  `Ecto.Enum, values: [:queued, :running, :passed, :failed]`
  (`src/generator/elixir/vanilla/schema-emit.ts:432`), so a **loaded** field is
  the **atom** `:passed`. `:passed == "passed"` is always `false`. Therefore
  `Build.passed()` is permanently false and `Build.promote`'s
  `precondition passed()` can **never** succeed on the Elixir backend.
- **Stale rationale:** the renderer comment and the pinning test
  (`test/generator/elixir/phoenix-render-expr.test.ts:105`) assume a plain
  `:string` column. The schema later moved to `Ecto.Enum` (schema-emit "Slice 3")
  but `render-expr.ts` and the test did not follow. It still *happens* to work
  inside Ecto `where:` queries (Ecto casts the literal against the field type),
  which is why the regression went unnoticed — only the **in-memory** comparison
  path is broken.
- **Fix is context-sensitive (not a one-line flip):**
  - **relational** aggregates (`Ecto.Enum`) → must render the atom `:passed`;
  - **document**-shaped aggregates rehydrate the enum from jsonb as a **string**
    (`src/generator/elixir/vanilla/document-emit.ts:56` casts enum as plain
    `:string`) → must keep the string;
  - inside an Ecto `where:` either form works, but the atom is idiomatic.
  The renderer needs to know the storage shape (relational vs document) and/or
  query-vs-in-memory context. `store-emit.ts:180` already renders the atom form
  (`:#{nm}`), so the two emitters currently disagree.
- **Blast radius:** any pure domain function / operation body that compares an
  enum field on a relational aggregate. `Build.promote` is the showcase example;
  the bug is general.

## 🔴 BUG-2 · Workflow-invoked operation args are silently dropped (Elixir)

- **Where (output):**
  - `phoenix_api/lib/phoenix_api/catalog/workflows/register_project.ex:22`
    ```elixir
    {:ok, _} <- Context.add_pipeline_project(proj, %{arg0: "default"}) do
    ```
  - `phoenix_api/lib/phoenix_api/builds/workflows/promote_to_production.ex:39`
    ```elixir
    {:ok, _} <- Context.promote_build(b, %{arg0: "production"}, current_user) do
    ```
- **Where (root cause):** `src/generator/elixir/dispatch-emit.ts:599` and
  `src/generator/elixir/domain-service-emit.ts:211` build the op-call param map
  with **positional atom keys** (`arg${i}:`).
- **Why it's wrong:** the op facade reads params by **real name as string key**:
  `catalog.ex:115` → `label = Map.get(params, "label")`,
  `builds.ex:53` → `env = Map.get(params, "env")`. So
  `Map.get(%{arg0: "default"}, "label")` is `nil`: every workflow-driven
  operation call passes `nil` for **all** of its arguments (a double mismatch —
  wrong name *and* atom-vs-string key).
- **Scope:** Elixir-only. hono / java / python / .NET emit workflow op-calls
  correctly (no `arg0` anywhere in their output).
- **Fix:** emit the called operation's actual parameter names as **string** keys
  (`%{"label" => ...}`), mirroring the controller path the facade was written
  for. Gate with a fixture compiled under `mix compile --warnings-as-errors`
  that drives a workflow op-call.

---

## 🟡 Minor / consistency

- **Python — Update DTOs lack wire validators.** `CreateXRequest` Pydantic
  models carry `Field(...)` constraints + `@model_validator`, but
  `UpdateXRequest` (e.g. `python_api/app/http/project_routes.py`
  UpdateProjectRequest) do not, so an invalid PUT fails at the domain floor (400)
  instead of the wire (422) like create does. Cross-backend consistency
  question — may be by-design.
- **React menu — label falls back to page *name*, not *title*.**
  `src/generator/_frontend/menu-emitter.ts:181`:
  `overrideLabel ?? metaLabel ?? page.name` skips `page.title`, so `link ProjectNew`
  (no explicit label) renders `"ProjectNew"` instead of its declared
  `title: "New project"`. Adding `?? page.title` before `?? page.name` would be a
  sensible default.

## Discarded (false positives)

- **Phoenix "duplicate timestamps":** the migration *does* emit `timestamps()`
  alongside the domain `created_at` column, matching the schema — consistent.
- **React `key={idx}`:** the source explicitly sets `keyExpr: "idx"` on that
  Table; index-keying is the author's request, not an emitter error.
- **React unused `useParams()`:** the showcase `ProjectDetail` page genuinely
  never references `id` (all literal values), so the discarded call is dead but
  not wrong.
- **.NET, Java:** end-to-end traces of operations / workflows / events / views /
  DTOs / JPA+Flyway columns found nothing out of place.
