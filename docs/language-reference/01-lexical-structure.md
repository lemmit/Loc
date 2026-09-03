# 1. Lexical structure

The tokens and file-level structure beneath every other chapter: comments, identifiers, literals and how their delimiters are stripped, the soft-keyword rule that lets reserved words double as field names, and multi-file source via `import`. Reach for it when a name won't parse, a string survives onto the wire differently than you wrote it, or you're splitting a project across files.

> **Grammar:** `ID`, `STRING`, `INT`, `DECIMAL`, `DURATION`, `TRACE_ID`, `TEMPLATE_FULL`/`_START`/`_MIDDLE`/`_END`/`_FORMAT` (terminals), `WS`/`SL_COMMENT`/`ML_COMMENT` (hidden), `Model`, `ImportStmt`, `CommonSoftKeywords`, `Property.name`, `LooseName`, `NameRefIdent` · **Validators:** — · **Docs:** [`../language.md`](../language.md)

Whitespace and comments are hidden terminals — ignored between tokens — so layout is free. Two number terminals are distinguished by the dot: `INT` is `/[0-9]+/`, `DECIMAL` is `/[0-9]+\.[0-9]+/`. A third, `DURATION` (`/[0-9]+(ms|s|m|h|d)/` — `15s`, `5m`), is declared before `INT` so `15s` lexes as one token; it is accepted only as a `timerSource`'s `every:` cadence — in expressions a span is spelled `days(n)` / `hours(n)` / `minutes(n)` (see [Expressions](05-expressions.md)).

## Comments

Line (`//` to end of line) and block (`/* … */`). Both are hidden terminals (`SL_COMMENT`, `ML_COMMENT`) — stripped before parsing, so they never reach the AST and never appear in generated output. Block comments do not nest.

```ddd
// line comment — to end of line
context Orders {
  /* block comment
     spanning lines */
  aggregate Order {
    total: money   // trailing comment
  }
}
```

No generated tab: comments are discarded at the lexer, so no platform emits anything for them.

## Identifiers

`ID` is `/[_a-zA-Z][\w_]*/` — a letter or underscore, then letters, digits, or underscores. Case-sensitive: `Order` and `order` are distinct. There is no separate Unicode-identifier rule; identifiers are ASCII-word.

One neighbour to know about: `TRACE_ID` (`/[A-Za-z][A-Za-z0-9]*(-[A-Za-z0-9]+)*-[0-9]+/` — `US-001`, `AC-12`, the ids of `requirement` / `testCase` / `verifies`) is declared before `ID` for longest-match priority. It must end in `-<digits>`, so ordinary identifiers fall through to `ID`; the only collision is an **unspaced** subtraction ending in a number (`x-1`), which lexes as one trace id. House style spaces binary operators (`x - 1`).

```ddd
context Orders {
  aggregate Order {
    customerId: string     // camelCase
    order_total: money     // snake_case is admitted too
    _internalSeq: int      // leading underscore is legal
  }
}
```

Casing is **yours to choose in the source, but the backends re-case on emission** through `src/util/naming.ts` (`upperFirst` / `lowerFirst` / `snake` / `plural`). The important nuance: `upperFirst`/`lowerFirst` touch only the first character — they do **not** normalise `snake_case`. So a snake_case field name diverges across backends: TypeScript keeps it verbatim, while .NET property-cases it by uppercasing the first letter and leaving the underscore in place (`order_total` → `Order_total`), exactly as `upperFirst`'s contract states. The database column, derived via `snake`, stays `order_total` on both.

`aggregate Order { order_total: money }` emits:

::: tabs backend
== node
```ts
// domain/order.ts — TS keeps the source casing verbatim
private _order_total: Decimal;
get order_total(): Decimal { return this._order_total; }
static create(input: { order_total: Decimal; currency: Currency }): Order { /* … */ }
```
```ts
// db/schema.ts — column name via snake()
order_total: numeric("order_total", { precision: 19, scale: 4 }).notNull(),
```
== dotnet
```csharp
// Domain/Orders/Order.cs — upperFirst: first char only, underscore kept
public static Order Create(decimal order_total, Currency currency)
{
    e.Order_total = order_total;   // property is PascalCase-of-first-char
    // …
}
```
```csharp
// Application/Orders/Responses/OrderResponses.cs — wire record property
public sealed record OrderResponse(
    [property: Required] Guid Id,
    [property: Required] string Order_total,
    [property: Required] Currency Currency);
```
::: end

The DB column is identical on both (`"order_total" DECIMAL(19, 4) NOT NULL` in each migration — `money` is `numeric(19, 4)`); only the host-language member name differs. House style is to write `camelCase` fields so the divergence never bites — but the rule above is what governs anything you do write.

## Literals

String, integer, decimal, boolean, `null`, plus the backtick **template string** and the `money("…")` literal. The `STRING` terminal is `/"(\\.|[^"\\])*"/` — double-quoted, standard backslash escapes.

```ddd
context Orders {
  enum Currency { USD, EUR, GBP }
  aggregate Order {
    note: string = "ships in 2-3 days"   // string literal
    qty: int = 0                          // INT
    rate: decimal = 1.5                   // DECIMAL (the dot is required)
    active: bool = true                   // boolean
    canceledAt: datetime? = null          // null
  }
}
```

**Delimiter stripping (re-quote on emission).** `STRING.value` arrives at the compiler with its quotes already removed — `"USD"` is the 3-character string `USD`, not the 5-character `"USD"`. Anything that emits a string literal must therefore **re-quote**, by convention via `JSON.stringify` or the target's equivalent. Enum members make this visible: written bare in the source, they are emitted as re-quoted string literals in the wire/DB layer.

`enum Currency { USD, EUR, GBP }` emits:

::: tabs backend
== node
```ts
// db/schema.ts — bare members re-quoted into a string array
export const currencyEnum = pgEnum("currency", ["USD", "EUR", "GBP"]);
```
== dotnet
```csharp
// Domain/Enums/Currency.cs — emitted as a real CLR enum, members verbatim
public enum Currency
{
    USD,
    EUR,
    GBP
}
```
::: end

Money has its own literal form, `money("10.50")` — see [Type system](04-type-system.md) — whose argument is a `STRING` (precise-decimal, never a float). It is distinct from `DECIMAL`; `1.5` is a lossy `decimal`, `money("1.50")` is precise.

**Template strings** are backtick-delimited with `{expr}` holes: `` `Order {n} for {customer.name}` ``. The lexer splits one into `TEMPLATE_FULL` (no holes) or a `TEMPLATE_START … TEMPLATE_MIDDLE* … TEMPLATE_END` sequence with an expression between each pair; a dedicated `interpolation` lexer mode keeps a hole's `}` from closing the enclosing block (which is why a hole may not itself contain a `{ }` literal). A comma at hole-paren-depth 0 begins an optional ICU format suffix (`TEMPLATE_FORMAT`): `{total, number, ::currency/USD}`. Literal braces / backticks in the text are `\{` / `\}` / `` \` ``. See [Expressions](05-expressions.md) and [`../language.md`](../language.md) → "String interpolation".

## Soft keywords

Loom keeps the hard-reserved set to declaration heads, type names and expression keywords. Many words that act as keywords in one position are **soft keywords** — reserved only in the rule that uses them, and admitted as ordinary identifiers everywhere else. This is what lets a domain field be named `state`, `kind`, `payload`, `query`, `body`, `parent`, `money`, `action`, `paged`, `option`, `or`, `write`, `migration`, … without colliding with the page DSL, the storage-clause keys, the payload-family declarations, the policy verbs, or the type-carrier syntax.

Mechanically: the grammar factors the shared set into one rule, `CommonSoftKeywords`, and composes it into every *value* position — `Property.name` (field names), `LooseName` (parameter / argument / clause names), `NameRefIdent` (bare references in expressions), `LValueIdent` (assignment targets) and `MemberName` (after `.`). Each of those rules then adds a few position-specific extras, so the soft set is **not identical across positions**: `await` is soft as a *field* / parameter name but not as an expression ref (it is the `match await` marker there); `api`, `route`, `component`, `menu`, `section`, `link`, `targets`, `framework`, `design`, `ui`, `contains` are soft as parameter names and expression refs but **not** as field names (`aggregate Order { route: string }` is a parse error — pick another name); `create` / `destroy` are soft only as expression refs; `of`, `allow`, `deep`, `global`, `policy`, `persistence` are soft only as `LooseName`. They bind as keywords only where their owning rule begins. A word with a *hard* position in one of these rules stays a per-rule extra rather than joining the common set; `test/language/keyword-identifier-completeness.test.ts` pins the factoring.

```ddd
context Orders {
  aggregate Order {
    state: string      // `state` is the page-DSL state-block keyword — soft as a field
    kind: string       // `kind` is a DataSource clause key — soft as a field
    payload: string    // `payload` begins a PayloadDecl at context level — soft as a field
    parent: Order id?  // `parent` is the requirement-hierarchy keyword — soft as a field
    money: int         // even `money` (a primitive type / MoneyLit) is soft as a name
    write: int         // the `policy` verb — soft as a field
    migration: int     // the top-level ledger-block head — soft as a field
  }
}
```

The same word, in its keyword position, is hard:

```ddd
// `state` heads a page state block; `payload` heads a top-level payload record.
payload OrderPlaced { orderId: string }   // here `payload` is the declaration keyword

ui Web {
  page Home {
    state { count: int }                  // here `state` is the state-block keyword
  }
}
```

The `CommonSoftKeywords` set today (soft in **every** value position, hard only in its own rule): `action`, `asc`, `body`, `by`, `canonical`, `channels`, `command`, `config`, `connection`, `crossTenant`, `dataSources`, `desc`, `description`, `env`, `envelope`, `error`, `eventLog`, `every`, `favicon`, `filter`, `group`, `handle`, `immutable`, `implements`, `instance`, `internal`, `isolationLevel`, `join`, `keyPrefix`, `kind`, `literal`, `loads`, `mailer`, `managed`, `message`, `migration`, `money`, `objectStore`, `ogImage`, `option`, `or`, `paged`, `parent`, `payload`, `query`, `queue`, `readonly`, `replica`, `resource`, `response`, `retain`, `retrieval`, `schema`, `secret`, `select`, `service`, `snapshot`, `sort`, `sql`, `stamp`, `state`, `store`, `tablePrefix`, `tenancy`, `title`, `token`, `ttl`, `use`, `write`. The grammar rules are the source of truth — `CommonSoftKeywords` plus the per-rule extras on `Property`, `LooseName`, `NameRefIdent`, `LValueIdent` and `MemberName` in `src/language/ddd.langium`.

No generated tab: soft-keyword admission is a parse-time concern; the resulting field/enum/declaration emits exactly as its non-keyword-named sibling would.

## `import` & multi-file source

`ImportStmt` is `'import' path=STRING ';'?` — a path-based include of another `.ddd` file, resolved **relative to the importing file** (`"./shared/money.ddd"` against that file's directory). Imports may only appear at the top of a file, before the model members. `import` is a hard keyword.

```ddd
// main.ddd
import "./shared/money.ddd"
import "./orders.ddd"

system Shop {
  subdomain Sales { context Orders { /* … */ } }
}
```

```ddd
// shared/money.ddd — declared at model root: ambient across the whole project
valueobject Money { amount: decimal, currency: string }
enum Currency { USD, EUR, GBP }
```

```ddd
// orders.ddd
context Orders {
  aggregate Order {
    total: Money         // root-level Money resolves here, across files
    currency: Currency
  }
}
```

Semantics:

- **Imports are file-loading, not visibility.** The CLI's project loader walks the import graph transitively from the entry file (conventionally `main.ddd`) and registers every reachable document with one shared global scope; the rest of the pipeline sees one merged model. There is no autodiscovery — a `.ddd` file nobody imports is not part of the project.
- **Ambient (model-root) vs context-local.** `valueobject`, `enum`, the `payload` family, `capability`, expression-form `function`, and `component` may be declared at the model root. Those form an implicit shared kernel, visible workspace-wide: root VOs / enums / payloads resolve into every context's type space, root components into every page body. Aggregates, events, repositories, projections, workflows, handlers and policies stay inside their `context`. The deployment-shape members (`deployable`, `storage`, `resource`, `channelSource`, `ui`, `layout`, `theme`, `user`, `auth`, `api`, `test e2e`), a `migration "…" { … }` block, the traceability declarations and a `test "…" for <Subject>` are root-admissible too — root deployment members compose into the project's single `system`, so deployment can live in its own file.
- **Cross-context aggregate references are unchanged** by imports — a `X id` reference still resolves only to an aggregate in the *same* context; `import` does not relax that. A context-local VO/enum that shadows a root-level one of the same name is a hard error, and root-level VO/enum, system, and context names must each be unique across the whole project.
- `generate system <main.ddd>` is the multi-file-aware entry point; legacy `generate ts` / `generate dotnet` keep single-file semantics.

No generated tab: `import` shapes which documents compose into the model; the emitted code is identical to writing the same declarations in one file. See [`../language.md`](../language.md) §"Multi-file projects" for the full ruleset.
