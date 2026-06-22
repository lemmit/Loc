# 21. Externs

> **Grammar:** `extern` operations, `extern from "…"` components/functions · **Validators:** extern body restriction (preconditions only) · **Docs:** [`../extern.md`](../extern.md)

Escape hatches to hand-written code with a typed boundary: `extern` operations (body is preconditions only; backend handler registry), and `extern` UI components/functions emitting typed `.props.ts` / signatures.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`extern` operation** — body contains only preconditions; the per-backend handler registry (.NET `IOpNameHandler`, Hono typed registry + register/verify gate).
- **`extern` component** — `component X(...) extern from "…"`; emitted `.props.ts` interface.
- **`extern` function** — `function f(...) extern from "…"`; emitted signature + shim.
