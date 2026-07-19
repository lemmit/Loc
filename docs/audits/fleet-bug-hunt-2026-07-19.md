# Fleet bug-hunt audit (2026-07-19)

A snapshot-in-time bug audit of the compiler + all target generators, produced
by a 12-dimension agent fleet (one finder per compiler/generator area, each
finding then adversarially verified by two independent lenses: *does the code
path exist as claimed* and *is it truly a defect, not pinned/intended
behavior*). 78 agents ran; 33 raw findings came back and **all 33 survived
two-lens verification** (several dimensions independently rediscovered the
same root cause — a strong signal, counted once below). Deduplicated: **25
unique bugs**. None overlap in-flight open PRs.

Snapshot: `main` @ `ad8aa3c` (plus the branch-local forms.ts record-threading
fix). Like every file under `docs/audits/`, this is a snapshot — **not**
authoritative for what ships today. Verify against fresh `main` before fixing.

> **Update (2026-07-19, follow-up PR):** section **E** (the Java backend's
> incomplete Jackson-3 migration — E1/E2/E3) has been **fixed**: the stale
> `com.fasterxml.jackson.databind`/`.core` references were repackaged to
> `tools.jackson.*`, the Jackson-2-only mapper idioms migrated to the Jackson-3
> builder API (`new ObjectMapper().findAndRegisterModules()` →
> `JsonMapper.builder().findAndAddModules().build()`, and the `.visibility(…)`
> builder calls → `.changeDefaultVisibility(vc -> vc.withVisibility(…))`), the
> `openapi-customizer` swagger-core interop **kept** on Jackson 2 (swagger-core
> is Jackson-2-based — its `Json.mapper()` throws the checked
> `JsonProcessingException`), and the finder-param import collector corrected
> (E3). Verified by `gradle testClasses bootJar` (JDK 25) on generated
> document/`json`, event-sourced, OIDC-auth, and extern-resource projects. All
> other sections below remain open.

> **Update (2026-07-19, follow-up PR):** section **D1** (document-shape
> repository breaking on an optional single containment) has been **fixed** —
> in **both** the TypeScript and the Python document builders (the audit
> flagged TS; Python had the identical bug and was fixed with it). The
> `toDoc`/`fromDoc` helpers and the `Doc` type now None/null-guard a nullable
> single containment (`coupon == null ? null : couponToDoc(coupon)` /
> `(None if a.coupon is None else _coupon_to_doc(a.coupon))`), mirroring the
> embedded builders. Verified by `tsc --noEmit` on the emitted Hono project
> and `mypy --strict` on the emitted FastAPI project, plus regression tests in
> both backends. Other sections remain open.

> **Update (2026-07-19, follow-up PR):** section **F1** (scaffolded `money`
> field rendered a `Decimal` as a React child) has been **fixed** — money now
> emits the `Money` formatter primitive and the eight React packs' `MoneyValue`
> accepts the `Decimal` structurally (see §F1 note). Verifying F1 surfaced a
> **new, distinct** build-break, **F1b** (the scaffolded money *form*'s RHF
> resolver input≠output typing), documented at §F1b and **not yet fixed**.
> Other sections remain open.

Severity legend: **build-break** — generated project fails its own compile
gate; **wrong-value** — compiles but computes/serves incorrect results;
**boot-break** — generated stack fails to start/migrate; **UX** — visible
cosmetic/content defect.

---

## A. Numeric semantics — cross-backend divergence

### A1. `int / int` has no defined semantics — five backends, two answers *(wrong-value; + build-break on Python)*

Found independently by **five** dimensions (expr-ts-cs, expr-ex-py-java,
hono-backend, phoenix-backend, ir-lowering) — the single loudest signal of the
hunt.

The type system stamps `int / int → int` (`src/language/type-system.ts:588-592`),
but every backend renders `/` through its native operator:
TS (`src/generator/typescript/render-expr.ts:581`), Python
(`src/generator/python/render-expr.ts:610`), Elixir
(`src/generator/elixir/render-expr.ts:1053`) do **float** division, while C#
(`src/generator/dotnet/render-expr.ts:355`) and Java
(`src/generator/java/render-expr.ts:838`) **truncate**. `derived half: int =
qty / parts` with 5/2 yields `2.5` on node/Python/Elixir and `2` on .NET/Java —
the same fully-resolved IR means two different things.

Knock-ons:
- **node** serves `2.5` on a field its own wire schema declares `z.number().int()`.
- **Python** emits `def half(self) -> int: return self._qty / self._parts` —
  `mypy --strict` (the `python-build.yml` gate) rejects it:
  `Incompatible return value type (got "float", expected "int")`. Valid `.ddd`
  input fails its own compile gate.
- **Elixir** emits a float into a field whose OpenApiSpex schema says
  `type: :integer`.

Fix direction: decide one semantics in the type system / IR. Either integer
division is intended (TS → `Math.trunc(a / b)`, Python → `//`-with-sign-fix or
`int(a / b)`, Elixir → `div/2`) or `/` always produces a fraction (widen the
result type to decimal, making C#/Java use decimal division). Either way all
five renderers must agree.

### A2. `avg(λ)` over an int projection truncates on .NET; the same desugar doesn't compile on Java *(wrong-value / build-break)*

`avg` desugars (`src/ir/lower/lower-expr.ts:659-705`) to
`count == 0 ? null : sum(λ) / count`. On .NET, `.Sum(Func<T,int>)` returns
`int` and `.Count()` returns `int`, so the division is **integer** division
*before* the widening to the declared `decimal?`:

```csharp
public decimal? AvgQty => (this.Lines).Count() == 0 ? null
  : (this.Lines).Sum(l => l.Qty) / (this.Lines).Count();  // 1.5 → 1
```

TS/Python return the true mean (`1.5`). An average must never truncate — the
.NET value is wrong, not merely divergent. The exists-lens verifier also
corroborated that Java's emission from the same desugar
(`mapToInt(...).sum().divide(...)`) does not compile at all.
Primary file: `src/generator/dotnet/render-expr.ts:779` (sum leaf) + the
desugar. Fix: coerce the numerator (or the division) to decimal for non-money
numeric projections on the typed backends.

### A3. Python `%` is floored modulo; every other backend truncates *(wrong-value)*

`pyBinOp` (`src/generator/python/render-expr.ts:616`) passes `%` through
verbatim. Python's `%` follows the **divisor's** sign; JS/TS, Java, .NET and
Elixir (which deliberately emits `rem/2`) all follow the **dividend's** sign.
`-5 % 3`: Python `1`, everyone else `-2`. Python is the sole outlier. Fix:
emit a truncated-modulo form (e.g. `int(math.fmod(a, b))`) for int/long `%`.

### A4. Java `money * int` / `money / int` with a non-literal operand does not compile *(build-break)*

`promoteMoneyOperands` only promotes numeric **literals**; a field/param int
operand reaches Java's `renderMoneyBinary`
(`src/generator/java/render-expr.ts:889/893`) raw, emitting
`total.divide(this.qty(), MathContext.DECIMAL128)` — `BigDecimal` has no
`multiply(int)` / `divide(int, MathContext)` overload, so `derived unit: money
= this.total / this.qty` fails `gradle testClasses`. TS/.NET/Python all
compile the same model. Fix: wrap integral operands in
`BigDecimal.valueOf(...)` in the Java renderer, or promote non-literal scalar
operands in lowering so every backend receives a decimal operand.

---

## B. Money / Decimal / datetime comparison and serialization

### B1. TS `sortBy` over a money projection sorts lexicographically *(wrong-value)*

`TS_COLLECTION_RENDERERS.sortBy` (`src/generator/typescript/render-expr.ts:408`)
compares projected keys with native `<`/`>`. Money keys are decimal.js
`Decimal` instances whose `valueOf()` is a **string** — `Decimal(10) <
Decimal(9)` is `true`. The sibling min/max renderers (lines 423-430) already
special-case money to `.lt`/`.gt` for exactly this reason; sortBy was missed.
.NET orders correctly. Fix: mirror the min/max money handling in the sortBy
comparator (`.cmp`).

### B2. TS `money[].contains(x)` is always false *(wrong-value)*

`contains` emits `recv.includes(value)`
(`src/generator/typescript/render-expr.ts:403`); `Array.includes` uses
SameValueZero, i.e. reference identity for `Decimal` objects —
`[new Decimal(5)].includes(new Decimal(5))` is `false`. .NET's
`List<decimal>.Contains` is value-equal and correct. Fix: emit
`recv.some(p => p.eq(value))` for money element types.

### B3. Elixir `sortBy` uses structural term ordering on datetime/decimal keys *(wrong-value)*

`Enum.sort_by(recv, mapper)` (`src/generator/elixir/render-expr.ts:767-770`)
defaults to `&<=/2` term ordering: `%DateTime{}` compares map fields
alphabetically (`:day` before `:month` before `:year` — day-of-month order,
not chronological), `%Decimal{}` compares `coef`/`exp` (2 sorts before 1.5).
The same file's min/max already dispatch `DateTime.compare` /
`Decimal.compare` via `reductionSorter` (lines 811-822); sortBy was left on
the default. Compiles clean, sorts wrong at runtime; every other backend sorts
correctly. Fix: pass the type-aware sorter/sort-module (`Enum.sort_by(list,
mapper, DateTime)`, `{:desc, Decimal}`) like min/max.

### B4. Python `.sum(λ)` over money has no `Decimal` start value *(build-break + wrong-value)*

`sum((λ)(__x) for __x in recv)` (`src/generator/python/render-expr.ts:479`)
defaults the accumulator to int `0`: mypy types it `Decimal | Literal[0]` →
`mypy --strict` gate failure; at runtime an **empty** collection returns int
`0` for a money value (Java gives `BigDecimal.ZERO`, .NET `0m`). Fix: emit a
type-appropriate start (`sum(..., Decimal(0))` for money).

### B5. Python main `to_wire` path serializes money via `str()` — scientific notation on the wire *(wrong-value)*

`wireValue` (`src/generator/python/repository-builder.ts:1447`) emits
`str(expr)` for money; `str(Decimal)` produces `9.999999999999989E+28`-style
output for exponent-carrying values. The project ships `money_str`
(`format(x, 'f')`, "wire parity ... matching Java's toPlainString()") and the
event-sourced/workflow/views wire paths already use it — only the primary
relational/document/embedded REST path doesn't. Fix: use `money_str` in
`wireValue`.

---

## C. Collection-op holes

### C1. No-paren `.first` / `.firstOrNull` is accepted by the validator and broken on **every** backend *(build-break / runtime crash)*

The type system (`type-system.ts:1018-1021`) and lowering
(`lower-expr.ts:2157-2160`) bless the property-style form (`lines.first`,
`lines.firstOrNull`), but lowering only converts a collection op to a
`method-call` when parens are present (`lower-expr.ts:580` gates on
`ms.call`), so the bare form lowers as a plain member access. Emissions:
Elixir `record.lines.first_or_null.label` (BadMapError at runtime —
`src/generator/elixir/render-expr.ts:537` fallthrough; only
`count`/`length`/`distinct` are special-cased), TS `this._lines.first`
(`undefined` → TypeError), Python `AttributeError`, Java `List.first()`
(compile error). The call form works everywhere. Fix at the shared layer:
lower a bare collection-op MemberSuffix to `method-call` with
`isCollectionOp` regardless of parens.

### C2. .NET `firstOrNull()` over a value-type collection returns `default(T)`, not null *(wrong-value)*

`firstOrNull` → `.FirstOrDefault()` (`src/generator/dotnet/render-expr.ts:787`).
For value-type elements (int/decimal/bool/datetime/guid) an empty sequence
yields `0`/`false`/`MinValue` widened into `T?` as **non-null** — masking
emptiness. TS/Python/Java all return null/None. Fix: emit a null-lifting form
(`.Select(e => (T?)e).FirstOrDefault()` or an explicit count guard, as min/max
already do).

---

## D. Hono/TS repositories

### D1. `shape(document)` breaks on an optional single containment *(build-break + runtime crash)*

`contains coupon: Coupon?` on a document-shaped aggregate: `entityToDocFn`
(`src/generator/typescript/repository-document-builder.ts:329-334`) emits
`coupon: couponToDoc(a.coupon)` where the getter is `Coupon | null` but the
helper takes non-null (TS2345; null deref at runtime); `docTypeAlias` (line
393) types the doc field non-null; `entityFromDocFn` (369-370) has no null
guard, so a stored `null` cell crashes on load. The **embedded** sibling
builder handles the identical case correctly
(`repository-embedded-builder.ts:68-74, 122-126`) — a document-shape-only
divergence for validator-accepted input. Fix: port the embedded builder's
`optional`-flag guards.

---

## E. Java backend — incomplete Jackson 3 migration (#2027 leftovers)

### E1. `json` entity fields import Jackson-2 `JsonNode`; DTOs import Jackson-3 *(build-break)*

`collectJavaTypeImports` (`src/generator/java/render-expr.ts:1010`) still adds
`com.fasterxml.jackson.databind.JsonNode` while the wire layer
(`emit/wire.ts:70`) adds `tools.jackson.databind.JsonNode`. Any aggregate with
a `json` field gets two *different* `JsonNode` classes across entity/DTO —
cross-layer assignments don't compile, and the v2 class isn't on the Spring
Boot 4.1 classpath at all. #2027 built green only because its example had no
`json` field. Fix: one-line repackage at render-expr.ts:1010.

### E2. document-store / event-store / auth / resource-clients / service / openapi-customizer still import Jackson 2 *(build-break)*

21 remaining `com.fasterxml.jackson.databind.*` / `.core.*` references across
`src/generator/java` (`emit/document-store.ts:190`, `emit/event-store.ts`,
`emit/auth.ts:193/201/598/789`, `adapters/resource-clients.ts:169/235`,
`emit/service.ts:255`, `openapi-customizer.ts:741`). `ObjectMapper`,
`MapperFeature`, `json.JsonMapper`, `node.NullNode` moved to
`tools.jackson.databind.*`; `JsonProcessingException` became
`tools.jackson.core.JacksonException`. Compile-breaks every `shape: document`
aggregate, event-sourced aggregate, JWT auth, and extern resource client.
(`program.ts`/`workflow-eventsourced.ts` were migrated — these files were
simply missed.) Jackson **annotations** stay `com.fasterxml.jackson.annotation`
(correct as-is).

### E3. Service finder with a `decimal` (or bare `guid`) param references an un-imported type *(build-break)*

`emit/service.ts:190` renders finder params with `renderJavaType(p.type)`
(domain type: `BigDecimal`/`UUID`) but line 192 collects imports with
`collectWireToDomainImports`, which adds nothing for `decimal` (identity
conversion) — `richerThan(BigDecimal min)` with no
`import java.math.BigDecimal;`. The JPA repository sibling imports correctly.
Fix: collect with `collectJavaTypeImports` to match the rendered signature.

---

## F. Frontend walker / UI

### F1. Scaffolded bare `money` field renders a Decimal object as a React child *(build-break + runtime crash)*

`kindForType` (`src/macros/stdlib/scaffold/_body-builders.ts:899-903`) lumps
`money` in with int/decimal as `{ tag: 'numeric' }` → `<Text>{row.total}</Text>`.
But money deserializes client-side to a decimal.js `Decimal` instance
(`moneySchema` transform), which is not a `ReactNode`: `tsc` fails and React
throws "Objects are not valid as a React child". Unexercised by CI — every
matrix example models money as a value object. Fix: give money its own
ColumnKind (Money primitive or `.toString()`).

> **Update (2026-07-19, follow-up PR): F1 fixed.** `money` gets its own
> `{ tag: 'money' }` ColumnKind that emits the `Money` formatter primitive
> (`<MoneyValue value={row.total} />`), and the eight React packs' `MoneyValue`
> `value` param is widened structurally to `number | string | { toString():
> string } | null | undefined` (the same pattern the Svelte packs already use
> so it accepts a `Decimal` without importing decimal.js). `int`/`decimal`/
> `long` stay `numeric` (plain numbers). Verified: the scaffolded list/detail
> cells now `tsc`-clean; regression test in `walker-formatters`. **NOTE — a
> *second*, distinct money-scaffold build-break surfaced during F1 verification
> and is NOT yet fixed (see F1b).**

### F1b. Scaffolded create/update **form** over a bare `money` field fails `tsc` (RHF resolver input≠output) *(build-break — NEW, not in the original 33)*

Discovered while verifying F1. A scaffolded `CreateForm`/`UpdateForm` (or op/
workflow form) over an aggregate with a bare `money` field emits
`useForm<Create<Agg>Request>({ resolver: zodResolver(Create<Agg>Request), … })`.
`Create<Agg>Request` is the schema's **output** type (`z.infer`/`z.output` —
`total: Decimal`), but `zodResolver` types the resolver's **input** as
`z.input` (`total: string | Decimal`, because `moneySchema` is a transform). So
`Resolver<{total: string | Decimal}, …>` is not assignable to the
`Resolver<{total: Decimal}, …>` the single-generic `useForm` expects → TS2322/
TS2345 in `new.tsx` + `detail.tsx`. Money is the only field type whose
`z.input ≠ z.output`, so only bare-`money` forms hit it (the matrix's
money-as-VO cases have `amount: decimal`, input=output). Untested for the same
reason as F1.

Fix direction: emit the RHF three-generic form
`useForm<Create<Agg>FormState, unknown, Create<Agg>Request>` (the `FormState` =
`z.input` alias is already emitted by `api-module.ts` `dualTypeAliases`
whenever a request reaches money), **conditionally** — only when the form
reaches money, since the `FormState` alias is only emitted then — and add the
`FormState` type import. Spans `form-of-decls` / `form-op-module` /
`form-runs-decls` across the 8 React packs + the form-context builder. A
focused cross-pack change; tracked here as its own item rather than rushed into
the F1 PR.

### F2. `match { … }` in expression/text position silently emits `undefined` *(wrong-value, all JSX frontends)*

`emitExpr` in the shared walker (`src/generator/_walker/walker-core.ts:1248-1465`)
handles `ternary` but has no `case "match"` — a match used as a *value* (Text/
Heading/Button label, `Field error:`, `state := match{…}`, string concat) hits
the default arm: `{/* unsupported expr: match */ undefined}`. The same match
in child position works (walk line 899 handles it). Fix: add the `match` arm
delegating to `ctx.target.renderMatch`.

### F3. Double-quote in user strings breaks JSX attribute positions *(build-break)*

`unwrapAsAttr` (`src/generator/_walker/shared/args.ts:90-93`) and `testidAttr`
(`walker-core.ts:1849`) paste a `JSON.stringify`'d literal into an attribute:
`label="First & \"Last\""` — JSX attributes don't process backslash escapes,
so the attribute closes at the inner quote (TS1382). Visible text is correctly
escaped; only attribute sites are not. Fix: brace-wrap the JS literal
(`label={"…"}`) or use the existing `escapeHtmlAttr` (a11y-emit.ts).

### F4/F5. Vue and Svelte action-button auth gates render the literal text "null" *(UX)*

`controls.ts:270` passes the JSX render-nothing sentinel `"null"` as the else
branch of `renderConditionalChild`. React drops it (JSX null), Angular
special-cases it (`angular-target.ts:461`), but Vue
(`src/generator/vue/walker/vue-target.ts:404`) emits
`<template v-else>null</template>` and Svelte
(`src/generator/svelte/walker/svelte-target.ts:308`) emits `{:else} null {/if}`
— users failing a `requires` gate see the word **null** where the hidden
button should be nothing. Fix: mirror the Angular guard in both targets.

---

## G. IR / validation holes

### G1. A `this`-referencing field default is spliced verbatim into the wire request schema *(boot-break on node+Python; silent contract change on .NET/Java)*

`avgPrice: int = this.total / this.count` on a plain field passes validation
(no constant-expression check on field defaults). `wireCreateDefault`
(`src/ir/enrich/wire-projection.ts:169`) forwards the instance-scoped ExprIR
to every create-request emitter: Hono emits
`z.…().default(this.total / this.count)` at module scope (TS2683 +
`TypeError` on import — the server never boots); Python emits
`avgPrice: int = self.total / self.count` in a pydantic class body
(`NameError` at import); .NET/Java silently **drop** the default and make the
field a required create input. Fix: validator for constant-only wire defaults,
or treat instance-referencing defaults as "no wire default" uniformly.

### G2. Auto-versioning collides with a user-declared `version` field *(boot-break)*

`applyDefaultVersioning` (`src/macros/expander.ts:299`) splices `versioned`
(`version: int = 1`) into every non-eventLog aggregate;
`mergeScopedMembers` (line 680) silently drops the injected field on a name
collision, but `expandCapability` (line 523) still tags the aggregate
`versioned`. For `aggregate Release { version: string; … }` the migration
builder then stamps `default = "1"` on the **text** column by name
(`migrations-builder.ts:1708-1710`): Postgres rejects
`"version" TEXT NOT NULL DEFAULT 1` at CREATE TABLE — the stack never boots —
and the Hono repository inserts `version: 1` (number) into a `text` column and
computes `expected + 1` on a string. Fix: skip auto-versioning when a
`version` member exists (or its type ≠ int), only push the capability tag when
the field was actually spliced, and add a `loom.*` diagnostic for the
collision.

---

## H. Scaffold naming

### H1. Scaffold's module-local `plural()` diverges from `src/util/naming.ts` *(wrong URLs/labels; frontend↔backend route mismatch)*

`_body-builders.ts:1216-1220` and `_pages.ts:255` carry a private `plural()`
handling only `y→ies` (even after a vowel) and `s→es` — missing the canonical
`(s|x|z|ch|sh)→+es` and the vowel-y guard. `Box` scaffolds `/boxs` routes, nav
label `Boxs`, testids `boxs-*` while the generated API client calls `/boxes`
(canonical); `Gateway`→`gatewaies`. The comment at `_body-builders.ts:1205`
already admits the copy is a shortcut. Fix: import the canonical helpers.

---

## I. Phoenix migrations

### I1. Multi-module Phoenix deployable: delta versions collide and sort before their create-table *(boot-break)*

`emitInitial` offsets initial migration filenames per module
(`MODULE_VERSION_STRIDE`, `migrations-emit.ts:131`) but the offset is never
persisted into the snapshot (`migrations-builder.ts:1323-1326` stamps bare
`BASE_TIMESTAMP` for every module) and `emitDelta`
(`migrations-emit.ts:491-494`) applies no offset. Next generation: every
module's first delta is `20260101000001` → Ecto aborts on the duplicated
version, and module 1's delta sorts **before** its own create-table
(`relation does not exist`). Ecto-specific (requires globally-unique ordered
integer prefixes; the SQL backends don't). Fix: persist the stride into the
snapshot `lastVersion` (or offset deltas in `emitDelta`).

### I2. Ecto `alterColumnType` omits the `USING` cast the shared SQL renderer emits *(migration-apply failure)*

`sql-pg.ts:44-48` emits `ALTER … TYPE <to> USING x::<to>` — used by TS, .NET,
Python, Java. The Elixir emitter (`migrations-emit.ts:549-554`) renders
`modify :x, <type>, from: <old>` with no USING/fragment, so any
non-implicitly-castable change (`string→int`) fails on Phoenix only
("cannot be cast automatically"). Fix: `execute/1` the shared sql-pg statement
(the pattern renameIndex/backfill in the same file already use).

---

## Raw-finding → unique-bug map

| Unique | Raw findings (dimension) |
|---|---|
| A1 | 1 (expr-ts-cs), 7+8 (expr-ex-py-java), 10 (hono), 16 (python), 20 (phoenix), 29 (ir-lowering) |
| A2 | 2 (expr-ts-cs), 11 (dotnet) |
| A3 | 5 · A4 | 28 · B1 | 3 · B2 | 4 · B3 | 6, 21 · B4 | 17 · B5 | 18 |
| C1 | 19 · C2 | 12 · D1 | 9 · E1 | 13 · E2 | 14 · E3 | 15 |
| F1 | 22 · F2 | 23 · F3 | 24 · F4 | 25 · F5 | 26 |
| G1 | 27 · G2 | 30 · H1 | 31 · I1 | 32 · I2 | 33 |

## Suggested fix order (when picked up)

1. **Build-breaks reachable from common models**: E1/E2/E3 (Java Jackson —
   mechanical), A4 (Java money·int), D1 (document optional containment), B4
   (Python money sum), F1 (scaffolded money field), F3 (attr escaping).
2. **Boot-breaks**: G1, G2, I1, I2.
3. **Semantics decisions needing a design call first**: A1 (pick one `int/int`
   semantics — touches type system + five backends + conformance), A2, A3, C1
   (fix in shared lowering), C2.
4. **Silent wrong-values**: B1, B2, B3, B5, F2.
5. **Cosmetic/UX**: F4, F5, H1.

Each item above carries enough file:line + repro context to be picked up as an
independent slice; A1/A2/C1 belong together as one "numeric semantics"
mission (shared lowering + all five backends + a conformance behavioral test).
