# 5. Expressions

> **Grammar:** `MatchExpr`..`PostfixChain`, `Lambda`, `LiteralExpr`, `CallExpr`, `MemberSuffix` · **Validators:** expr typing in `src/ir/lower/lower-expr.ts` · **Docs:** [`../criterion.md`](../criterion.md)

The expression language shared by invariants, derived fields, operation bodies, filters, views, and pages. Literals through operators, precedence, member access and calls, collection operators, `match`, lambdas, and the magic references.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Literals** — string/int/decimal/bool/null, `now()`, `money("…")`, list literals `[…]`, builder calls `Part { … }`.
- **Arithmetic & widening** — `+ - * / %`; `int < long < decimal`; closed `money` arithmetic.
- **Comparison & logical** — `< <= > >= == !=`, `&& || !`.
- **Ternary & `match`** — `cond ? a : b` and `match { c => v, else => f }`.
- **Member access & calls** — `a.b`, `a.b(x)`, free `f(x)`; `callKind` resolution.
- **Collection operators** — `.count`, `.sum`, `.all`, `.any`, `.where`, `.first`/`.firstOrNull`, `.contains`, `.map`/`.filter` (frontend).
- **Lambdas** — `x => expr` and `x => { stmts }`.
- **Conversions** — `string(x)`, `long(x)`, `decimal(x)`, `money(x)` widening/lossy.
- **Magic references** — `this`, `id`, `currentUser`, `permissions.<name>`.
