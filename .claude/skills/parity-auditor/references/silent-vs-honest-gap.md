# Silent vs honest gap — the classification recipe

The one judgment this skill exists to get right. A "gap" is any feature a target
doesn't fully support. The question that decides its priority and its fix is:
**does valid `.ddd` using that feature on that target get rejected, or does it
quietly emit something wrong?**

## The two classes

**HONEST gap (`✗ gated`)** — the target is omitted from the validator gate set, so
valid `.ddd` that uses the feature gets a hard `loom.*-unsupported` error at
validate time. The user is told plainly; nothing mis-emits. This is the *designed*
state for an unsupported combination — Loom's hard rule is that an unsupported
combination must **fail fast at validate time, never silently downgrade**. An
honest gap is a feature task: hand it to `language-feature-developer` to close (or
leave it gated if support isn't wanted).

**SILENT gap (`🔴`)** — the target is *absent from the gate's checked set* **AND**
the emitter produces nothing for the feature (or `# TODO`s it / throws a raw
`Error` mid-generation / crashes codegen). Valid `.ddd` passes validation and you
get a backend that's quietly wrong. This is a **correctness bug**, the highest-
priority find of an audit, and the thing the gates exist to prevent. The
historical example (backend audit Finding F1): Python was absent from
`LIMITED_FAMILIES` *and* the Python generator never consumed `contextFilters`, so
a `with softDelete` / tenancy `filter` on a Python aggregate passed validation and
emitted reads with **no WHERE scoping** — soft-deleted rows leaked and tenancy
isolation silently vanished.

A near-cousin worth a separate note:

**`⚠ partial`** — the target emits *something* but not the whole feature (e.g. the
vanilla Phoenix backend handles the common shape of an operation but defers a rarer
sub-case to a validator gate). Partial is honest only if the *unsupported* slice fails fast; if the
unsupported slice silently no-ops, it's a 🔴 hiding inside a ⚠. Check the boundary.

## The recipe

Three steps per (feature, target) cell. You need both the gate side and the
emitter side — a gate alone doesn't tell you whether the emitter is honest.

### 1. Find the gate and read its membership

```
# the named gate set + its membership, on fresh main
rg -n "_BACKENDS|_CAPABLE|_FAMILIES|new Set\(\[" \
   src/ir/validate/checks/system-checks.ts src/ir/validate/checks/structural-checks.ts
# which check fn consumes it, and the loom.* code it raises
rg -n "validate\w+Support|loom\.[a-z-]+unsupported" \
   src/ir/validate/checks/system-checks.ts src/ir/validate/validate.ts
```

Record: is the target **in** the set (claims support) or **out** (claims to
reject)? Watch for the separate elixir branch
(`FOO.has(p) || (p === "elixir" && elixirFooCapable)`) — read the `||` clause; with
a single foundation it resolves to one `✓ elixir` / `✗ elixir` cell.

### 2. Grep the emitter for the IR field the feature populates

The decisive test for a 🔴 is: does the generator for this target actually consume
the IR the feature lowers to? Find the field (from `src/ir/types/loom-ir.ts` or the
lowering), then grep each target's generator dir for it. The backend audit's own
method block is the template:

```
# does THIS backend consume the feature's IR field?
rg -rn contextFilters src/generator/python/        # zero hits  -> emits nothing
rg -rn contextFilters src/generator/node/ src/generator/java/   # hits -> consumes it
```

Zero hits in the target that the gate *doesn't* reject = a 🔴 silent gap, proven.
Hits = the emitter is real; the gap (if any) is honest or partial.

### 3. Grep the emitter for crash/stub markers

A second silent-gap shape is the emitter that *tries* and fails loudly mid-
generation (a raw throw or a `# TODO` placeholder) rather than gating up front:

```
rg -n "throw new Error|# TODO|TODO:|FIXME|notImplemented|unsupported" src/generator/<target>/
```

Read each hit in context and classify:

| What you find | Class | Why |
|---|---|---|
| Target absent from gate set **and** emitter has zero hits on the IR field | 🔴 silent | Validates, emits nothing real — correctness hole |
| Target absent from gate set **and** emitter throws a **raw** `Error` mid-codegen | 🔴 silent | Validates then crashes — violates "validates ⇒ generates" |
| Emitter emits a `# TODO`/placeholder string for valid input | 🔴 silent | Compiles but is a stub — quietly wrong |
| Target in gate set **and** emitter consumes the IR field | ✓ | Real support |
| Target absent from gate set **and** the gate raises `loom.*-unsupported` for it | ✗ gated (honest) | Fails fast — the designed state |
| `throw new AdapterNotImplementedError(...)` reached only when validator already gates the combo | ✗ gated (honest) | The throw is a defensive backstop behind a gate, not a reachable crash |

That last row matters: not every `throw` in a generator is a 🔴. Many are
*unreachable defensive throws* behind a validator gate (e.g. the elixir adapter
`AdapterNotImplementedError`s for `style: layered`/`cqrs` stubs, or `heex-target.ts`
throws on primitives the validator/`heex-parity` set already excludes). A throw is
only a 🔴 if **valid `.ddd` can reach it** — i.e. nothing upstream gates the input
that triggers it. Confirm reachability by checking whether the validator rejects
that input first; if it does, the throw is honest (defensive), not silent.

### Confirm with the corpus harness (run it)

The cleanest proof is to actually generate the feature across targets and bucket
the outcome. Reuse the compile-tier corpus (no docker):

```ts
import { generateCorpusCase } from "test/fixtures/corpus/harness.js";
import { corpusSourceFor } from "test/fixtures/corpus/harness.js";
// corpusSourceFor(featureId, backend) swaps `platform: __PLATFORM__`
// generateCorpusCase(featureId, backend) -> Map<path,content> or throws
```

…or from the CLI on a materialized fixture:

```bash
node bin/cli.js generate system <feature>.<backend>.ddd -o /tmp/out
```

Three outcomes map straight to the three classes:

1. **emits the artifact** (grep the file map for the expected construct — not just
   non-empty) → `✓`.
2. **throws a `loom.*-unsupported`** → `✗ gated` (honest).
3. **emits a file map with the feature missing, or throws a raw `Error` / emits a
   `# TODO`** → `🔴 silent`.

If the feature has no corpus fixture yet, adding one is in-scope: drop a
platform-agnostic `<feature>.ddd` (using the `platform: __PLATFORM__` token) under
`test/fixtures/corpus/` and a row in `manifest.ts` (`corpus-coverage.test.ts`
enforces the manifest↔fixture↔doc completeness). Keep it token-parameterized so
every backend reuses the one source.

## What each classification means for the next action

- **🔴 silent** → highest priority. The **safe interim** is almost always a one-line
  gate widening: add the target to the `FOO_BACKENDS`/`LIMITED_FAMILIES` set so the
  feature `loom.*-unsupported`s on that target instead of mis-emitting. That alone
  restores the parity invariant and needs no feature build. The principled fix
  (actually emit the feature) is the follow-up — hand it to
  `language-feature-developer` with the sibling backend that already emits it as
  the analog to mirror. Call out *both* options in the hand-off so the maintainer
  picks.
- **✗ gated (honest)** → a normal feature task. Hand to `language-feature-developer`:
  port the analog backend's emitter, narrow the gate as the target gains support,
  add one generator test + the backend's build gate.
- **⚠ partial** → confirm the unsupported slice fails fast (else it's a hidden 🔴),
  then treat the remaining slice as an honest gap.
- **Frontend pack/primitive crash** → ship the missing `.hbs` to the pack and add
  the name to the pack `RequiredSet` (or `TSX_ONLY_PRIMITIVES` if it renders inline
  on Phoenix), so the load-time gate names the offending pack instead of crashing
  mid-generation.

The invariant every classification serves: **a model that passes validation must
generate on its target, or fail validation — never crash codegen and never
silently downgrade.** A 🔴 is exactly a violation of that invariant; draining it
means moving the cell to either `✓` (emit) or `✗ gated` (reject), nothing in
between.
