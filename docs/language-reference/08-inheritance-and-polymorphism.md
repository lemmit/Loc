# 8. Inheritance & polymorphism

> **Grammar:** `abstract aggregate`, `extends`, `inheritanceUsing` · **Validators:** `loom.*` inheritance codes; TPC `<Base> id` rejection · **Docs:** [`../inheritance.md`](../inheritance.md)

Abstract base aggregates, concrete subtypes via `extends`, the two table-mapping strategies (`sharedTable` TPH vs `ownTable` TPC), and the polymorphic `find all <Base>` reader.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`abstract aggregate`** — base never instantiated; no table/repo/routes; may declare fields/derived/functions.
- **`extends`** — concrete subtype; field merge into `wireShape`; shadowing.
- **TPH (`sharedTable`)** — one table + `kind` discriminator; `<Base> id` refs allowed. Show the SQL.
- **TPC (`ownTable`)** — one table per concrete; `<Base> id` refs rejected. Show the SQL.
- **`find all <Base>`** — polymorphic union read across subtypes; per-backend reader.
