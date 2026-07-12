# 0. Introduction & notation

Loom is a declarative DSL for Domain-Driven Design. A `.ddd` source
describes a **system** of bounded contexts — aggregates, value objects,
events, repositories, workflows, views, APIs, storage, and UI — and the
toolchain compiles it into a runnable multi-project tree wired together
as one `docker compose` stack. Five backends (TypeScript/Hono,
.NET/ASP.NET, Phoenix LiveView, Python/FastAPI, Java/Spring Boot) and four
frontends (React, Vue, Svelte, Angular) consume the same source.

This reference documents **the language surface**, feature by feature.
It is not a tutorial and not a generator internals guide — for those see
[`../language.md`](../language.md) (prose tour) and
[`../technical.md`](../technical.md) (pipeline internals).

## How to read it

The reference is **non-sequential**. Each chapter stands alone and
cross-links the others. Two ways in:

- **Answer a question** — jump straight to the chapter for the construct
  (the [index](README.md) maps every keyword to its home).
- **Learn a surface** — read a chapter end to end; features within it are
  ordered from foundational to advanced.

## The example convention

Every feature carries **two examples**: the Loom source you write and the
target output it generates. The generated output appears in a **tabbed
picker** — choose the platform you care about; your choice follows you
across the page and across the reference.

Here is the convention itself, shown on a trivial aggregate. The same
`.ddd` declaration, lowered to three backends:

```ddd
context Catalog {
  aggregate Product {
    name: string
    price: money
  }
}
```

::: tabs backend
== node
```ts
// One row in the emitted Drizzle schema (excerpt)
export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  price: numeric("price").notNull(),
});
```
== dotnet
```csharp
// EF Core entity (excerpt)
public sealed class Product
{
    public Guid Id { get; set; }
    public string Name { get; set; } = default!;
    public decimal Price { get; set; }
}
```
== python
```python
# SQLAlchemy model (excerpt)
class Product(Base):
    __tablename__ = "products"
    id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid7)
    name: Mapped[str]
    price: Mapped[Decimal]
```
::: end

> The tabs above are illustrative of the *format*. Each chapter's
> examples are sourced by actually running the generator — see
> [`AUTHORING.md`](AUTHORING.md).

When a feature is backend-only (a repository query) or frontend-only (a
page primitive), only the relevant tabs appear. When backends diverge —
say TPH vs TPC table mapping — that divergence is the point, and the tabs
sit side by side so you can compare.

## Notation

- `code font` marks Loom keywords, rule names, and generated identifiers.
- A `.ddd` fence is **input** you write; a tabbed fence is **output** the
  compiler emits.
- Grammar rule names (`Aggregate`, `Operation`, `MatchExpr`) refer to
  productions in [`src/language/ddd.langium`](../../src/language/ddd.langium).
- Validator codes (`loom.bare-aggregate-in-type`) refer to diagnostics
  raised by the validators under `src/language/validators/` and
  `src/ir/validate/`.
- Each chapter opens with a front-matter callout naming the **grammar
  rules**, **validators**, and **deep-dive docs** relevant to it.

## The pipeline, in one breath

Every feature in this reference is a slice through the same ten-phase,
strictly one-directional compiler. Knowing the shape helps you predict
*where* a feature shows up in the output:

```
.ddd → ① parse → ② macro expand → ③ scope/link → ④ AST validate → ⑤ lower
     → ⑥ enrich → ⑦ IR validate → ⑧ per-platform codegen → ⑨ system compose → ⑩ write
```

- **Phases ①–④** are the *language* surface — syntax, names, AST-level
  rules. Chapters 1–9 mostly live here.
- **Phase ⑤–⑦** lower the AST to the platform-neutral, fully-resolved
  **Loom IR** (`src/ir/types/loom-ir.ts`). Every name carries a kind,
  every expression a type. Backends never re-resolve.
- **Phase ⑧** is where the tabs diverge: each backend/frontend turns the
  *same* IR into its own source. This is what the per-platform examples
  capture.
- **Phase ⑨–⑩** compose the deployables into a stack and write the tree.

The full walk-through is in [`../technical.md`](../technical.md). You do
not need it to use the language — but it explains why the same `.ddd`
produces structurally compatible output across five backends.
