# Surface redundancy cuts — one spelling per concept

**Status:** PARTIALLY SHIPPED — cuts #1 (`ids guid`), #2 (`criterion { where: }`),
and #3 (legacy `ui X { framework }` block binding) landed in PR #1795. Cut #4
(`write global`) is kept-as-is (validator error, by design); cut #5 (`static`
platform) was investigated and **dropped** (see §5). Nothing further open here.
**Theme:** language-surface stability. Removes pure redundancy /
single-value / always-invalid syntax — "which spelling do I use, do they
differ?" surprises with **no capability lost**.

## Principle

A stable, smooth surface never offers two ways to say one thing, a knob with
one legal value, or a form that always errors. None of these is a *feature*;
each is a small surprise. This proposal removes only those — not
unimplemented-but-roadmapped surface (that is signposted, not deleted; a
separate concern). The `with`/`implements` synonym is **not** here — it is
*split* (see [`with-implements-split.md`](./with-implements-split.md)), not
cut.

## Cuts

### 1. `ids guid` — single-value clause — ✅ SHIPPED (PR #1795)

`('ids' idKind=IdKind)?` with `IdKind returns string: 'guid'`
(`ddd.langium:927,936`) — one legal value, identical to writing nothing.
The footgun kinds (`int`/`long`/`string`) were already removed; this is the
vestigial no-op spelling of the default.

**Cut:** remove the `('ids' idKind=…)?` clause and the `IdKind` rule.
**Migration:** delete `ids guid` where sources wrote it (no-op).

### 2. `criterion … { where: e }` — redundant block form — ✅ SHIPPED (PR #1795)

```
Criterion:  … ( '=' body=Expression | '{' 'where' ':' body=Expression '}' )
```
(`ddd.langium:1446-1449`). The block form's *only* slot is `where:`, so it
lowers identically to `= e`. Unlike `retrieval` — whose block earns its keep
with `sort:`/`loads:` — the criterion block adds nothing over `=`.

**Cut:** remove the block alternative; keep `criterion X of T = e`.
**Migration:** `{ where: e }` → `= e`.

### 3. Legacy `ui X { framework: … }` block binding — ✅ SHIPPED (PR #1795)

`UiBlockBinding` (the colon-less `ui WebApp { framework: react }` *inside a
`deployable { }`*) — the grammar labelled it "legacy block form". Its only
distinguishing payload was a binding-site `framework:` override, redundant
with the `framework:` the `Ui` *declaration* itself carries.

**Verified before cutting:** the concern was that only `UiBlockBinding` could
express *divergent* per-binding frameworks for a shared `ui`. A repo-wide grep
found **no** such usage — every real adopter (showcase.ddd, and the
svelte-embed tests) set one framework per `ui`, expressible on the `Ui`
declaration. So it was pure redundancy, not a capability.

**Cut (done):** removed the `UiBlockBinding` alternative + rule, its
`lower-deployment.ts` / `deployable.ts` (old Rule 13) / `print-structural.ts`
branches. Migration = move `framework:` onto the `ui` declaration and mount
via bare `ui:` sugar (`ui: X { … }` with braces is `UiComposeBinding` for
*param* bindings, no framework slot). A negative test pins the colon-less form
as a hard parse error.

### 4. `write global` policy level — a parseable always-error

`allow write global on X` parses, then *unconditionally* fails validation
(`loom.policy-write-global-unsupported`, `ddd.langium:1089`) — root-subtree-
wide mutation is a deliberate never, not a roadmap gap. A grammatically
reachable state whose only destiny is an error.

**Cut — but keep the good message.** Do **not** downgrade to a raw parse
error: today's `loom.policy-write-global-unsupported` *explains why* global
writes are a deliberate never; a bare "expected `local` | `deep`" is a UX
regression (against the signposting principle — fail loudly *with a reason*).
Also, `level` is shared read/write in one rule (`PolicyReadRule`), so
excluding `global` for `write` alone likely needs a separate `WriteLevel`
rule — more grammar than "almost free." **Recommendation:** keep the
validator error and its message; treat this as already-handled, not a cut.
(Or, if cut, the parser must emit the *custom* diagnostic, not the default.)
**Migration:** none.

### 5. `static` platform — ❌ DROPPED from S2 (not a clean cut)

**Resolution (investigated, 2026-07):** not the redundancy it looked like,
and *not* cut. The verification turned up a deeper fact: the five frontend
"platforms" (`react`, `svelte`, `vue`, `angular`, `static`) are **one
static-bundle host + a default framework**, not five technologies. Every
frontend surface delegates to the same dispatcher —
`dispatchFrontendProject(deployable.uiFramework, /*fallback*/ "react", …)`
(`react.ts:26`, and the svelte/vue/angular siblings with their own fallback)
— so the framework actually rendered comes from **`ui.framework`**; the
platform keyword only supplies the default when the ui omits it. Given the
same ui, `platform: react` and `platform: static` emit byte-identical output
(`static: reactPlatform`, same fallback), and `svelte`/`vue`/`angular` differ
*only* in their default framework.

So `static` is the one *honestly-named* spelling of the static/Vite host;
`react` is the misleading one (it happily hosts a Svelte ui). Cutting
`static → react` would delete the framework-neutral name and keep the
misleading one — the wrong direction. The real redundancy (five platform
keywords encoding one host + a default, when the framework already lives on
the `ui`) is the **`platform: vite` unification** already scoped in
[`embedded-frontend-composition.md`](./embedded-frontend-composition.md) — a
deliberate design change, not an S2 mechanical cut. Left to that proposal.

## Not cuts (already done / out of scope)

- **`phoenix` / `phoenixLiveView` *platform* aliases** are **already
  retired** — they are not in the `Platform` rule (`ddd.langium:337`) and
  fail validation as unknown platforms (grammar note, `:329-332`). Nothing
  to cut. (`phoenixLiveView` as a *framework* value, `:318`, is the
  canonical HEEx name and stays.) **Doc-drift flag:** `docs/platforms.md`
  reportedly still says these aliases "desugar to `elixir`" — that prose is
  stale and should be scrubbed (a docs fix, not a language cut).
- **Reserved/half-built surface** (unrealized `StorageType` values, `cache`/
  `replica` kinds, inert `resource` knobs, `route`/`commandHandler`,
  `envelope`, `loads:`) is **roadmap**, not redundancy — signpost with a
  uniform "reserved, not emitted" diagnostic rather than deleting. Out of
  scope here.

## Why safe

Each cut removes a *way to be wrong* without removing any capability:
1–4 have trivial or empty migrations and no behavior change; 5 is explicitly
gated on verifying no distinct behavior. None touches the roadmap.
