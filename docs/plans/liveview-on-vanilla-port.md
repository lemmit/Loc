# LiveView on the vanilla (Ecto) foundation — de-Ash port plan

Status: **landing/landed (2026)**. Steps 1–4 of the de-Ash effort are landing: the
Ash foundation has been **removed**. `platform: elixir` now generates Phoenix LiveView
on **plain Ecto/Phoenix** (the vanilla foundation); `foundation: vanilla` is the default
and only valid value, and `foundation: ash` is now a **validation error** (the
`foundation:` knob itself stays). The design-pack rename + the two HEEx packs
`coreComponents` / `daisyui` are landed; this LiveView-on-vanilla port (step 2 of the
effort) and the default-flip / Ash-generator deletion (steps 3–4) are landing as the
markdown-docs scrub goes in.

End state (now reality): `platform: elixir` = Phoenix LiveView on plain Ecto, Ash gone.
The slice-by-slice plan below is retained as the implementation record of how the port
landed; the historical "Ash-only" framing describes the pre-removal starting point.

## Why a port, not a rewrite

The map (see investigation, 2025): the HEEx markup engine is **foundation-neutral and
reusable** — `heex-walker.ts`, `heex-walker-core.ts`, `heex-target.ts`, `heex-primitives.ts`
(markup), `sidebar-emit.ts`, `page-objects-emit.ts`, `theme-emit.ts`, `migrations-emit.ts`.
The Ash coupling is concentrated in three places:

1. **`liveview-emit.ts`** — reads use Ash bang code-interface (`list_x!()`, `get_x!()`),
   error handling rescues `Ash.Error.Query.NotFound` / `Ash.Error.Invalid`, and the
   form lifecycle uses `AshPhoenix.Form.for_create/for_update/validate/submit`
   (file:line: reads ~448/535/548; rescues ~540/541; forms ~470/530/622/628).
2. **`heex-primitives.ts::renderForm`** (~259–480) — relies on `AshPhoenix.Form`
   nested-changeset wiring for value-object fields.
3. **vanilla orchestrator/shell** (`vanilla/index.ts`, `vanilla/shell-emit.ts`) — emit
   no LiveView spine (router live_session / endpoint live socket+static / web-module
   live quotes / nav / root+app layouts / CoreComponents / `phoenix_live_view` deps).

`RenderCtx.foundation: "ash" | "vanilla"` already exists (render-expr.ts ~85–93), so the
shared emitters branch on it rather than fork.

## Vanilla context API the ported LiveView calls (from `vanilla/context-emit.ts`)

- `list_<agg>s(current_user \\ nil)` → repo `:list`
- `get_<agg>(id, current_user \\ nil)` → repo `:find_by_id`
- `create_<agg>(attrs, current_user \\ nil)` → repo `:insert` → `{:ok, _} | {:error, changeset}`
- `update_<agg>(record, attrs, current_user \\ nil)` → `:update`
- `delete_<agg>(record)` → `:delete`
- (changeset for forms: vanilla controllers build `Repo.changeset(record, attrs)` inline;
  the LiveView needs a `change_<agg>/2` facade or builds the changeset against the schema
  module — decide in 2-B; prefer adding a `change_<agg>` defdelegate for symmetry.)

Confirm exact read return shapes (`{:ok,_}` vs bare list/nil) against repository-emit.ts
before branching mount/handle_params.

## Slice 2-A — vanilla LiveView spine + read pages (compiles on a non-form `ui`)

Goal: a vanilla deployable with a **read-only** `ui` (hand-authored pages: `List` /
`Detail` / `Heading`, no `Form`) emits a LiveView app that `mix compile
--warnings-as-errors` accepts. Forms deferred to 2-B (a scaffolded `ui` emits forms, so
2-A is gated on a minimal non-form fixture).

1. **Share the LiveView shell renderers.** The Ash shell renderers in `shell-emit.ts`
   (web-module live/live_view quotes, endpoint live socket + `Plug.Static priv/static`,
   router `live_session` + `:browser` pipeline + live-route splice, `renderLiveNav`,
   root+app layouts, CoreComponents) are foundation-neutral (only comment-level Ash
   mentions). Extract them into a shared module (e.g. `shell/liveview-shell.ts`) — or
   export them — and have BOTH `emitShellFiles` (ash) and the vanilla path call them.
   Guard against changing ash output: byte-diff the ash fixtures before/after the extract.
2. **Vanilla shell deps.** Add `{:phoenix_live_view, "~> 1.0"}` (+ `{:phoenix_html, …}`
   already present, `{:floki, …}` test-only if needed) to `renderVanillaMixExs`. Add
   `socket "/live", Phoenix.LiveView.Socket` + `Plug.Static` for `priv/static` to
   `renderVanillaEndpoint`. Add a `:browser` pipeline + `live_session` + live-route splice
   to `renderVanillaRouter` (keep the `/api` scope). Extend `renderVanillaWebModule` with
   `live_view`/`live_component`/`html` quotes. Emit root+app layouts + CoreComponents +
   `nav.ex` (via the shared renderers).
3. **`liveview-emit.ts` reads.** Thread `foundation` into `emitLiveViewPages` (default
   `"ash"`, no-op for ash). Branch the read emission:
   - list: `Context.list_<agg>s()` (vanilla returns a bare list / `{:ok,_}` — match the
     repo) instead of `list_<agg>s!()`.
   - detail: `case Context.get_<agg>(id) do {:ok, r} -> … ; _ -> :not_found end` (or nil
     match) instead of `get_<agg>!()` + `rescue Ash.Error.Query.NotFound`.
4. **Vanilla orchestrator.** In `vanilla/index.ts`, when `deployable.uiName` and not
   `embedReact`: call `emitLiveViewPages({…, foundation: "vanilla"})`, `renderSidebarComponent`,
   `renderThemeCss`, collect `liveRoutes`, pass them to the shell. Stop skipping
   `live_auth.ex` once the deps are present (it needs `phoenix_live_view`).
5. **Gate.** New fixture `test/e2e/fixtures/elixir-ash-build/vanilla-liveview-read.ddd`:
   `foundation: vanilla` + a minimal non-form `ui`. `mix compile --warnings-as-errors`
   in docker (hexpm/elixir; `LOOM_HEX_MIRROR=1` if the proxy blocks hex). Add a
   `test/generator/elixir/vanilla-liveview-*.test.ts` asserting the spine + read shape.

## Slice 2-B — forms (Ecto changeset, compiles on a scaffolded `ui`)

1. **`liveview-emit.ts` form lifecycle (foundation branch).**
   - mount: `to_form(Context.change_<agg>(%Schema{}))` (or `Schema.changeset(%Schema{}, %{})`)
     instead of `AshPhoenix.Form.for_create(Resource, :create)`.
   - edit/op: `to_form(Context.change_<agg>(record, %{}))` instead of `for_update`.
   - validate event: `changeset = …|> Map.put(:action, :validate); {:noreply, assign_form(…)}`
     instead of `AshPhoenix.Form.validate`.
   - submit event: `case Context.create_<agg>(params) do {:ok, _} -> …; {:error, cs} ->
     assign_form(socket, cs) end` instead of `AshPhoenix.Form.submit`.
2. **`heex-primitives.ts::renderForm`** — vanilla VO fields use `<.inputs_for
   :let={vf} field={@form[:vo]}>` over `cast_assoc` changesets instead of relying on
   `AshPhoenix.Form` auto-nesting. The CoreComponents `<.input>`/`<.simple_form>` already
   work with `Ecto.Changeset` (Phoenix.HTML.FormData for changesets is built-in).
3. **`change_<agg>` facade** — add to `vanilla/context-emit.ts` if the LiveView needs it.
4. **Gate.** Switch the read fixture (or add `vanilla-liveview-scaffold.ddd`) to a
   `scaffold` `ui` on `foundation: vanilla`; `mix compile` green. The existing
   `daisyui-pack.ddd` (already `design: daisyui`) becomes the natural cross-check once it
   flips to `foundation: vanilla`.

## Asset pipeline (folds in here)

Neither foundation emits `app.css` / `tailwind.config.js` today (only `theme.css`). The
design packs carry `assets-css` / `tailwind-config` / `assets-js` templates that are
currently unemitted. When the vanilla LiveView shell lands, wire the elixir generator to
emit those pack templates (consuming `pack.render("tailwind-config")` etc.) so the
`daisyui` pack's `require("daisyui")` plugin + themes actually land in the generated
project — this is what makes the `daisyui` pack genuinely render, and it brings
`coreComponents` to parity. Gated by an asset-build step (or at least file-presence
assertions) in the elixir build workflow.

## Risk register (highest first)

1. Extracting the Ash shell LiveView renderers without changing ash byte output
   (byte-diff the ash fixtures before/after).
2. `liveview-emit.ts` form lifecycle — `AshPhoenix.Form` → Ecto changeset semantics
   (validate-on-change, error assignment, nested VO `cast_assoc`).
3. `heex-primitives renderForm` nested value-object forms.
4. Vanilla read return-shape mismatch (`{:ok,_}` vs bare/nil) → wrong pattern match →
   compile/runtime break.
5. `live_auth.ex` un-skip — must compile once `phoenix_live_view` is a vanilla dep.
6. Test churn: the ~15 `heex-*.test.ts` assert Ash form strings; the vanilla path needs
   its own assertions, and a few shared tests may need foundation params.
7. CI: the elixir build workflow is named/oriented around Ash; vanilla+LiveView needs a
   fixture cell (and eventually the asset-build presence check).
