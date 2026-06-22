# 15. UI: pages & structure

> **Grammar:** `Ui`, `Page`, `Component`, `Area`, `StateBlock`, `ActionDecl`, `MenuBlock`, `Layout` · **Validators:** walker-stdlib completeness; page-kind classification · **Docs:** [`../page-metamodel.md`](../page-metamodel.md)

The page DSL framing: the `ui` block and its members, `page` (route/title/requires/state/body/menu), `component` (params, `slot`, `action`, `extern`), `area` grouping, `state`/`derived`/`action` declarations, `menu`, `layout`, and the `scaffold` macro.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`ui`** — block with `framework:`, scaffold, api/channel params, notifications, functions.
- **`page`** — route, title, `requires`, `state { … }`, body, menu metadata, description/og.
- **`component`** — typed params incl. `slot`/`action`; `extern from "…"`; decls + body.
- **`state` / `derived` / `action`** — reactive local fields; computed; named event handlers.
- **`menu` & `layout`** — explicit sidebar; named layout slots (`main` Outlet, reserved names).
- **`with scaffold(...)`** — pages from domain (subdomains/contexts/aggregates/workflows/views); override by name.
