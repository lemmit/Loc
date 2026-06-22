# 6. Behavior & statements

> **Grammar:** `Operation`, `Create`, `Destroy`, `Apply`, statement rules (`PreconditionStmt`..`AssignOrCallStmt`) · **Validators:** body checks in `src/ir/validate/checks/` · **Docs:** [`../language.md`](../language.md)

How aggregates change state: `operation`, `create`, `destroy`, and the event-sourcing `apply` fold — plus the statement vocabulary their bodies use (`precondition`, `requires`, `let`, `emit`, `for`, `if let`, `return`, `:=` / `+=` / `-=`).

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`operation`** — public/`private` mutating method; modifiers `extern`, `audited`, `when <guard>` (canCommand + `GET /can_<op>`).
- **`create` / `destroy`** — canonical and named factories/terminators; `audited`.
- **`apply(e: Event)`** — event-sourcing fold (`persistedAs(eventLog)`); assignments + mutations only.
- **Guards** — `precondition Expr` (→ 400), `requires Expr` (→ 403).
- **`let` & `emit`** — local binding; `emit Event { … }`.
- **`for` & `if let`** — `for x in xs { … }`, `if let x = src { … } else { … }`.
- **`return`** — the exception-less `or`-union result.
- **Assignment** — `target := Expr`, collection `+=` / `-=`.
