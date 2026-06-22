# 9. Payloads, records & unions

> **Grammar:** `PayloadDecl` (`payload`/`command`/`query`/`response`/`error`), named & anonymous unions · **Validators:** union exhaustiveness; `loom.*` payload codes · **Docs:** [`../payloads.md`](../payloads.md)

The structurally-identical record family (`payload`/`command`/`query`/`response`/`error`), discriminated unions both anonymous (`A or B`) and named (`payload Foo = A | B`), and the tagged `type` wire they produce.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Record forms** — `payload X { … }`; the five intents and how they differ in routing/intent only.
- **Anonymous union `A or B`** — in any type position; lowered to a union IR; the tagged wire.
- **Named union `payload Foo = A | B`** — discriminated variants; exhaustiveness.
- **`error` & httpStatus** — error records and the exception-less ProblemDetails translation.
- **Per-backend DTO/serialization** — show the emitted union type + discriminator on at least two backends.
