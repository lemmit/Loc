# 22. Macros & the `with` clause

> **Grammar:** `with <Macro>(...)`; macro pipeline `src/macros/` · **Validators:** macro-arg resolution · **Docs:** [`../scaffold-macros.md`](../scaffold-macros.md)

Compile-time AST→AST expansion: the `with <Macro>(...)` invocation, argument forms, the stdlib (`scaffold`, `crudish`, `softDelete`, `audit`), project-local `.loom/macros`, and the `unfold` code action that ejects expanded source.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`with <Macro>(...)`** — invocation on aggregate/context/ui; arg forms (string/bool/int/bare-ID/`[ID,…]`).
- **Stdlib macros** — `scaffold*`, `crudish`, `softDelete`/`softDeleteByDefault`, `audit`/`auditable` — what each expands to.
- **Project-local macros** — `.loom/macros/*.ts` modules; the authoring surface (`defineMacro`).
- **`unfold`** — the LSP code action that rewrites a `with` clause into expanded `.ddd` source.
