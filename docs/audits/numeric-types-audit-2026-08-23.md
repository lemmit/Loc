# Numeric-types audit — int / long / decimal / money from DB to frontend (2026-08-23)

Snapshot: `main` @ `e98e3af18` (re-verified findings were traced on `ff0c2d87` and spot-checked after the two later merges; neither touches a numeric path). Sibling machine-readable fleet plan: [`numeric-types-audit-2026-08-23.plan.json`](numeric-types-audit-2026-08-23.plan.json). Missions minted from this register: **M-T1.21–M-T1.25, M-T2.14, M-T5.22–M-T5.24, M-T6.44–M-T6.48, M-T9.36–M-T9.38** (17).

## Why this audit exists

[#2545](https://github.com/lemmit/Loc/pull/2545), [#2560](https://github.com/lemmit/Loc/pull/2560), [#2575](https://github.com/lemmit/Loc/pull/2575) (×3) and [#2631](https://github.com/lemmit/Loc/pull/2631) were **five instances of one root cause in four days**: the number wire contract — money = fixed-scale-4 string (RS-12), decimal = float64 JSON number (RS-24), int/long = JSON integer — is a single cross-cutting decision *implemented as many scattered per-backend, per-read-path coercions*. Each new read path (per-row DTO, projection `select`, aggregate, group key, dapper raw SQL) re-makes the decision; some backends get it wrong; no gate enumerates the boundaries. This audit swept the whole chain — grammar/type-system → lowering → DDL/ORM → domain arithmetic → wire → all six frontends → the gates themselves — to drain the class instead of waiting for instance six.

**Method.** Four parallel deep audits (semantics/lowering, DB layer, app+wire layer, frontends), each tracing emitted output (several findings verified by generating a numeric-rich system and compiling/inspecting the output, or by node-level repro of the exact conversion). Findings are marked **CONFIRMED** (traced to emitted code or reproduced) or **SUSPECT** (code-level evidence, needs one runtime probe). Cited by SYMBOL, not line.

## The type vocabulary (ground truth)

| Type | Semantic | Storage (shared DDL) | Wire | Domain representation per backend |
|---|---|---|---|---|
| `int` | exact 32-bit | `INTEGER` | JSON integer | number / `int` / `int` / `int` / integer |
| `long` | exact 64-bit | `BIGINT` | JSON integer | **JS number (node)** / `long` / `long` / `int` / integer |
| `decimal` | fractional, wire-lossy by design (RS-24: carried through an IEEE-754 double) | unbounded `DECIMAL` | JSON number | **number (node)** / `System.Decimal` / `BigDecimal` / **`float` (python)** / `%Decimal{}` |
| `money` | exact, scale-4 wire (RS-12), `NUMERIC(19,4)` since #2575 | `DECIMAL(19,4)` | string, always 4 dp | decimal.js `Decimal` / `decimal` / `BigDecimal` / `Decimal` / `%Decimal{}` |

Widening chain `int → long → decimal` (`src/language/type-system.ts`); `/` on integrals widens to `decimal`, mechanized cross-backend by `isIntDivWidenedToDecimal` (`src/generator/_expr/target.ts`); money arithmetic is a closed commutative set (`moneyArithmetic`). Literal promotion (`tryPromoteNumericLit`) applies to **literals only** — a typed value never promotes, which is the door F7/F8 fall through.

## Findings

### Broken codegen — the generated product fails to build or crashes on first use

**F1 — Flutter money is broken end-to-end.** `dartFromJson` decodes a money field `(x as num).toDouble()` (`src/generator/flutter/dart-types.ts`) but the wire value is the RS-12 *string* `"12.5000"` → runtime `type 'String' is not a subtype of type 'num'` on every list/detail/projection/dashboard read. Forms submit money via `double.tryParse` as a JSON *number* (`src/generator/flutter/forms-emit.ts`) → 422/400 on every backend. The wrong behavior is test-pinned (`test/generator/flutter/dart-model.test.ts`), and money-through-`double` caps at ~15–17 significant digits vs `NUMERIC(19,4)`. CONFIRMED. → **M-T1.21**

**F2 — Feliz numeric conformance.** Plain `decimal` request fields encode via Thoth `Encode.decimal`, which emits a JSON **string** (right for money, wrong for decimal per RS-24) → 422 on node/.NET (`src/generator/feliz/wire.ts`; only the money arm is test-pinned). `fs-expr.ts` has no `isIntDivWidenedToDecimal` arm, so page-body `a / b` on ints **truncates** in F# where every other target yields 2.5. `long` collapses to F# `int` + `Decode.int` (rejects past int32). No numeric validation before `Encode.int`/`decimal` conversion — a stray `2.5` in an int field throws unhandled on submit (SUSPECT, rest CONFIRMED). → **M-T1.22**

**F3 — A money form input makes the generated React/Svelte app fail to build.** The page shell emits `import Decimal from "decimal.js"` while every pack's `field-input-money` template also declares `{from: "decimal.js", named: ["Decimal"]}` → `TS2300: Duplicate identifier 'Decimal'` (reproduced with tsc on emitted output; `src/generator/react/walker/page-shell.ts`, the Svelte twin, `designs/*/pack.json`). Invisible to `generated-react-build`/`-svelte-build` because **no matrix example renders a money-primitive form field**. CONFIRMED. → **M-T1.23**

**F4 — Svelte `createForm` strips the money default's prototype.** `$state(structuredClone(defaults))` (`src/generator/svelte/emit-templates.ts`) on the seed `new Decimal("0")` (`src/generator/_frontend/form-helpers.ts`) yields a prototype-less object: the input renders `[object Object]` and an untouched default can never pass `moneySchema`. Reproduced in node. CONFIRMED. → **M-T1.24**

**F5 — Money inside a `VO[]` dynamic-row form is unsubmittable.** `field-input-money` sits in the `NUMERIC` set of `src/generator/_walker/form-fields-vm.ts`, so array-row sub-fields register `{valueAsNumber: true}` with a numeric `0` default — the value is a JS number, which fails the `moneySchema` union; were it to pass, the wire would carry a JSON number. Flat money fields (Controller + Decimal) are correct; the array path diverges. CONFIRMED. → **M-T1.24**

**F6 — Angular money create/operation forms don't type-check.** The request interface says `price: string` while `controlInit` seeds `new FormControl(0)` behind a `type="number"` input (`src/generator/angular/form-fields.ts`, `src/generator/angular/api-module.ts`) → `TS2345` under `ng build`; suppressed, it would send a JSON number the backends reject. CONFIRMED. → **M-T1.24**

**F7 — TS + Elixir binary gates read only `leftType`.** The validator admits `int * money` as commutative (`moneyArithmetic`), and the IR stamps both operand types, but `renderMoneyBinary`'s gate in `src/generator/typescript/render-expr.ts` and the Elixir twin in `src/generator/elixir/render-expr.ts` check `leftType` alone. Verified by generating: node emits `this._qty * this._price` on a `Decimal` → **TS2363, uncompilable project**; elixir emits native `*` on a `%Decimal{}` → runtime `ArithmeticError`; worse, `int < decimal` on elixir falls to native `<` → Erlang **term ordering** (number < map ⇒ always true — silently wrong, no crash). Java fixed its own copy (`fleet-bug-hunt A4` arm in `src/generator/java/render-expr.ts`); the pattern was never ported. Same class as fleet-bug-hunt B3 (elixir term-ordering `sortBy`), new sites. CONFIRMED. → **M-T6.44**

**F8 — Python holds `decimal` as two different types in one backend.** `PY_TYPE_TARGET` types decimal params/signatures `float` while ORM columns are `Decimal` — `money * decimal` where the decimal came off the wire emits `self._price * f` with `f: float` → runtime `TypeError: unsupported operand Decimal * float`. Works only when the decimal came from a column. CONFIRMED. → **M-T6.45**

### Wire-contract divergences

**F9 — Java never got #2563's fix.** RS-24 fixed .NET (#2575: response `decimal` → `double`), but Java's `emit/wire.ts` types decimal `BigDecimal` in **both** directions with no narrowing, and a computed `a / b` renders through `MathContext.DECIMAL128` → **34 significant digits on the wire** where the other four ship a double's ≤17. (Java's *projection* arm is only accidentally double-parity: JPQL `avg` returns a provider `Double` before the BigDecimal re-wrap; sums and per-row/derived reads ship exact digits.) The .NET emitter's RS-24 comment claims "java's provider `Double`" — true only for `avg`. No `WRITE_BIGDECIMAL_AS_PLAIN` pinning either. Invisible to the differential — see F16. CONFIRMED. → **M-T6.46**

**F10 — The .NET decimal→double hops #2631 didn't reach.** #2631 (open at audit time) fixes the *dapper aggregate* arm by casting in SQL. The per-row hop remains: a stored high-precision decimal materializes into `System.Decimal` and crosses the `(double)` cast in `projectToResponse` (`src/generator/dotnet/dto-mapping.ts`) — the CLR decimal→double conversion is **not correctly rounded**. ~~Node writes `0.30000000000000004`; .NET reads it back as `0.3`.~~ **Correction (2026-08-24, #2675 — measured on .NET 10.0.11, not modelled): that example does NOT reproduce** — `0.30000000000000004` round-trips exactly. The mechanism is `DecCalc.VarR8FromDec` computing `(double)mantissa / 10^scale`: once the mantissa exceeds 2^53 the numerator is rounded to a double *first* and the quotient rounded again, so the result need not be the nearest double. Measured rate (3M samples, .NET 10.0.11): **9.20%** of doubles in `[0,100)` fail to round-trip (`99.52989333734583 → 99.52989333734584`). The EF aggregate arm is the same class **over a `decimal` column only** — #2631's "EF materializes a real double" holds for integral columns, which is what its fixture aggregated. CONFIRMED, both arms fixed in #2675. → **M-T6.47**

**F11 — Decimal *arithmetic* has no governing rule.** Node/Python compute in float64; .NET/Java/Elixir compute exact-decimal. `derived x: decimal = 0.1 + 0.2` ships (and **persists**) `0.30000000000000004` from two backends and `0.3` from three — a real, differential-catchable divergence with zero corpus coverage. `int / int` singles agree only coincidentally (double division is correctly rounded). Result *representations* also differ in-store (float64-17 / Decimal-28 / DECIMAL128-34 / Decimal-context-28 digits) in the shared unbounded `DECIMAL` column. Needs an owner ruling before the witness is added (the witness alone turns three backends red against the node oracle). CONFIRMED divergence; ruling proposed in the mission. → **M-T5.22**

**F12 — Malformed numeric input answers 500, not 4xx.** A bad money string (`"12,50"`) hits bare parses: .NET `decimal.Parse` → `FormatException`, Java `new BigDecimal` → `NumberFormatException`, Python `Decimal(str)` → `InvalidOperation`, Elixir op-params `Decimal.new` → raise — all **500**; only node (typed zod 400) and Elixir's create-changeset path (422) answer honestly. Elixir op-params also skip validation for plain `int`/`bool` (`coerceOpParam` in `src/generator/elixir/vanilla/context-emit.ts` covers only money/decimal/datetime → `Ecto.ChangeError` 500). Java likely **silently truncates** `1.5` → `1` for int request fields (Jackson `ACCEPT_FLOAT_AS_INT` default; no coercion config emitted — SUSPECT, one POST verifies). Stringified-number acceptance also skews: `"5"` for an int is accepted by java/python/elixir + node's create slot, rejected by node's body slot and .NET. CONFIRMED (java-truncation + skew statuses SUSPECT). → **M-T6.48**

**F13 — `long` has no contract.** Node stores it as a JS `number` (`bigint(col, {mode: "number"})` in `src/generator/typescript/emit/schema.ts`; mikroorm `ts: "number"`), python's aggregate arm goes through `float()` — silent corruption past 2^53 — while .NET/Java/Elixir carry int64 exactly. Aggregate int-overflow behavior is three-way divergent: Java `((Number) x).intValue()` wraps silently, .NET's `(int)` cast from decimal throws (500), the rest pass the too-big value through. No validator, no doc caveat. CONFIRMED. → **M-T5.23**

**F14 — Projection `avg` over money is typed `decimal`.** `src/ir/lower/lower-projection.ts` stamps `avg → decimal` even over a money column → the mean of exact money leaves as a lossy JSON double, while the in-memory `avg` of the same field types `money?` (`type-system.ts`) and ships a 4-dp string. Same word, two semantics, no gate. CONFIRMED. → **M-T5.24**

### Migrations

**F15 — `columnTypeEqual` is blind to precision/scale.** It compares `kind` only (`src/system/migrations-builder.ts`), and `decimal`/`money` share `kind: "decimal"` — so #2575's `NUMERIC(19,4)` DDL **never reaches an existing database** (no `alterColumnType` is ever diffed out; the "migration safety" paragraph in #2575's description is not delivered), and a user-visible `decimal ↔ money` field retype produces no migration. Fresh DDL is correct; only evolution is blind. CONFIRMED, twice independently. → **M-T2.14**

### The gates — why none of this was caught

**F16 — The wire-golden comparator is one-sided by construction.** `toWireEntry` JSON-parses each body before diffing (`test/_helpers/wire-record.ts`), collapsing every JSON number to a JS double: **deficient** precision (dapper's 15 digits, #2631) changes the parsed double and fails; **excess** precision (F9's 34 digits) parses to the identical double and *can never fail the gate*. The one direction that is currently broken is exactly the invisible one. CONFIRMED. → **M-T9.37**

**F17 — Flutter and Feliz have no runtime leg.** `generated-flutter-build.yml` / `generated-feliz-build.yml` are compile-only; `(x as num)` on a string compiles clean. React/Vue/Svelte/Angular get real e2e; the two frontends carrying the worst numeric bugs get none. (Consistent with M-T1.20's "the two self-hosting frontends carry most of it" through-line.) CONFIRMED. → **M-T9.38**

**F18 — Witness starvation** *(distributed — no standalone mission; each fix ships its witness)*. The flutter CI fixture declares `price: int` and a hand-rolled `valueobject Money { amount: int }` — the `money` **primitive** never reaches Flutter in any gate (→ M-T1.21). No build-matrix example has a money-primitive create form (→ M-T1.23). No corpus case has a right-hand money/decimal operand (→ M-T6.44), float-error-visible decimal arithmetic (→ M-T5.22), a `long` past 2^53 (→ M-T5.23), or a malformed-numeric probe (→ M-T6.48). This is the generalization of #2560's own diagnosis ("no corpus fixture grouped by a money column — exactly why nothing caught it"), recorded per-bug five times and never made structural (→ M-T9.36's boundary-enumeration gate).

### Annex — secondary observations (dispositioned, not all missioned)

- **S6 — money display fabricates "$"/USD and rounds to 2 dp** in every JSX/Angular/Vue/Svelte pack's `format-helpers` (`Number(value)` coercion, `decimals=2`, invented currency symbol — Loom money has no currency dimension, cf. M-T2.12); Feliz shows the raw 4-dp string, Flutter would use `NumberFormat.decimalPattern()`. Display-only, but there is no way to *see* the stored 4-dp value in the UI. → **M-T1.25** (P3, user-confirmed inclusion).
- Money > ~1e21 serializes exponential via decimal.js `toJSON` (`"1e+21"`), which the backend regex rejects → 422. Edge; folded into M-T6.48's ingress matrix as a probe.
- Int inputs silently truncate decimals client-side on some packs (`parseInt(v,10)||0`) while Mantine blocks and Angular round-trips an honest server 422; Mantine's `field-input-decimal` caps entry at 2 dp (`decimalScale={2}`). Pack-consistency items; folded into M-T1.24's acceptance notes.
- Node money arithmetic runs at decimal.js default 20-significant-digit precision (no `Decimal.set` emitted) vs 28+ elsewhere — a narrow window inside `NUMERIC(19,4)`'s 19 digits; folded into M-T5.22's ruling scope.
- Python ships declared-int aggregates through `float()` and relies on pydantic lax-mode re-coercion (`7.0`→`7`) — one strict-mode flip from a 500; folded into M-T5.23.
- Java: no `WRITE_BIGDECIMAL_AS_PLAIN` (scientific-notation risk for negative-scale values) — folded into M-T6.46.
- Cross-backend inbound `decimal` precision skew (node/python/elixir clamp through double; .NET accepts 28–29 digits; Java unlimited — a Java-written 30-digit value can `OverflowException` a .NET reader of the same column) — folded into M-T5.22's ruling scope (it is the request-side face of the same representation question).
- Doc drift: `docs/language.md`'s host-type table predates #2575 (.NET response `double`) and calls Java's decimal `double` (it is `BigDecimal`); the stdlib catalog signature `sum → decimal` (`src/util/collection-ops.ts`) disagrees with `type-system.ts` (sum types as the λ-body/element type). Folded into M-T5.22 (the docs travel with the rule).

## What is genuinely stable (verified clean — do not re-litigate)

- **Money's core contract**: one constant pair (`src/generator/money-scale.ts`), one storage type `NUMERIC(19,4)` in one shared DDL renderer, wire scale 4 with the **same rounding family (half-away-from-zero)** in all five backends *and* in Postgres' own insert rounding; `MONEY_WIRE_ZERO = "0.0000"` on every projection path. Every `toFixed`/`F4`/`setScale`/`quantize`/`Decimal.round` site was audited — no banker's-rounding straggler exists.
- **One DDL for everyone** — EF/JPA/Ecto/SQLAlchemy/Drizzle all execute the same Loom-rendered SQL; column shapes cannot drift per backend.
- The **stamped, fully-resolved IR** (operand/result types on every binary node) and the shared dispatchers (`_expr/target.ts`, `aggregateCoercion` in `src/ir/util/projection-aggregate.ts`) — the fixes above *use* these; none require new resolution machinery.
- **Seed literals**: exact SQL text on the raw path, exact decimal constructors on the domain path — no float hop anywhere in seeding.
- **Paged-carrier metadata** (`page/pageSize/total/totalPages`) is `int` across all backends and frontends; `wire-spec.json`, union scalar variants, and the served OpenAPI agree on integer/number/string(format: decimal).
- Node's hydration split (`Number` for decimal, lossless `new Decimal` for money) shared verbatim across drizzle/mikroorm/document adapters; the React/Vue/Svelte zod request schemas are field-for-field twins of Hono's `BODY_PRIMITIVE`.

## Finding → mission map

| Finding | Mission | Wave |
|---|---|---|
| F1 | M-T1.21 | 1 |
| F2 | M-T1.22 | 1 |
| F3 | M-T1.23 | 1 |
| F4, F5, F6 | M-T1.24 | 1 |
| S6 | M-T1.25 | 1 |
| F15 | M-T2.14 | 1 |
| F11 (+annex: node precision, inbound skew, doc drift) | M-T5.22 | 2 |
| F13 (+annex: python int-aggregate float) | M-T5.23 | 2 |
| F14 | M-T5.24 | 2 |
| F7 | M-T6.44 | 1 |
| F8 | M-T6.45 | 1 |
| F9 (+annex: BigDecimal plain) | M-T6.46 | 1 |
| F10 | M-T6.47 | 2 (after #2631) |
| F12 (+annex: 1e21 probe) | M-T6.48 | 1 (sequence after M-T6.46/47 in the shared wire files) |
| root cause | M-T9.36 | 3 |
| F16 | M-T9.37 | 2 (after M-T6.46) |
| F17 | M-T9.38 | 3 (after M-T1.21/22) |
| F18 | distributed (see above) | — |

Sources: #2545, #2549, #2560, #2563, #2575, #2631; [`fleet-bug-hunt-2026-07-19.md`](fleet-bug-hunt-2026-07-19.md) (A4/B3 are earlier instances of F7's class on other backends); `docs/conformance-semantics.md` RS-12/RS-24.
