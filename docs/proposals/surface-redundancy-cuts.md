# Surface redundancy cuts — one spelling per concept

**Status:** PROPOSED
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

### 1. `ids guid` — single-value clause

`('ids' idKind=IdKind)?` with `IdKind returns string: 'guid'`
(`ddd.langium:927,936`) — one legal value, identical to writing nothing.
The footgun kinds (`int`/`long`/`string`) were already removed; this is the
vestigial no-op spelling of the default.

**Cut:** remove the `('ids' idKind=…)?` clause and the `IdKind` rule.
**Migration:** delete `ids guid` where sources wrote it (no-op).

### 2. `criterion … { where: e }` — redundant block form

```
Criterion:  … ( '=' body=Expression | '{' 'where' ':' body=Expression '}' )
```
(`ddd.langium:1446-1449`). The block form's *only* slot is `where:`, so it
lowers identically to `= e`. Unlike `retrieval` — whose block earns its keep
with `sort:`/`loads:` — the criterion block adds nothing over `=`.

**Cut:** remove the block alternative; keep `criterion X of T = e`.
**Migration:** `{ where: e }` → `= e`.

### 3. Legacy `ui X { framework: … }` block binding

`UiBlockBinding` (`ddd.langium:301-304`) — the grammar labels it "legacy
block form". Its only distinguishing payload is a `framework:` override,
which is now also declarable on the `Ui` block itself (`ui X { framework:
react }`, `ddd.langium:385`) and on the `ui:`/`ui:{…}` sugar. Three binding
spellings collapse to two.

⚠️ **Verify first — this may be a real capability, not pure redundancy.**
The binding-site `framework:` override lives **only** in `UiBlockBinding`
(`ddd.langium:303`); neither `UiSugarBinding` (`:299`) nor `UiComposeBinding`
(`:250`) has a framework slot, and the `Ui` *declaration*'s `framework:`
(`:385`) is **one** framework per `ui`. CLAUDE.md notes the same `ui X` can
be served by different hosts ("a svelte host can also serve a `framework:
react` bundle") — so if two deployables bind one `ui X` with **divergent**
frameworks, *only* `UiBlockBinding` expresses that today; collapsing to the
`Ui` decl loses it.

**Cut only if** a grep confirms no source/example binds a shared `ui` with
divergent per-binding `framework:`. If none: remove the `UiBlockBinding`
alternative (+ its `deployable.ts` / `print-structural.ts` branches);
migration = move `framework:` onto the `ui` declaration (note: `ui: X { … }`
with braces is already `UiComposeBinding` for *param* bindings and has no
framework slot — only bare `ui: X` sugar remains). If a divergent binding
exists, this is a **capability removal** — keep it or redesign.

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

### 5. `static` platform — alias of `react` *(lower confidence — verify)*

`static: reactPlatform` (`registry.ts:82`); both `react` and `static` are
`isFrontend` frontend-only platforms mounting the same code path. If `static`
carries **no** behavior distinct from `react`, it is a redundant second
keyword for one backend.

**Before cutting, verify** it has no distinct semantics (e.g. a genuinely
backend-less "static site" mode vs. a react app that `targets:` a backend).
If distinct, keep it and *document the distinction* (the surprise is the
undocumented overlap, not the keyword). If not, consolidate on `react`.
**This one is a judgment call**, not a clean delete — listed for a decision,
not presumed.

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
