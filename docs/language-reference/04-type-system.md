# 4. The type system

> **Grammar:** `TypeRef`, `BaseType`, `PrimitiveType`, `IdType`, `GenericCtor` · **Validators:** type-system checks in `src/language/type-system.ts` · **Docs:** [`../payloads.md`](../payloads.md)

Every type position in the language: the primitive scalars, the distinct `money` type, `X id` cross-aggregate references, collections and options, and the postfix generic carriers `paged` / `envelope` / `option`.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **Primitive scalars** — `int`, `long`, `decimal`, `string`, `bool`, `datetime`, `guid`, `json`. Per-backend column/type mapping.
- **`money`** — distinct from decimal: precise, string-on-wire, closed arithmetic. Show the wire + column.
- **`X id` references** — cross-aggregate foreign key; why bare aggregate types are rejected.
- **Collections `T[]`** — arrays of scalars/refs; the `X id[]` association + join table.
- **Options `T?`** — nullable/optional; null on the wire and in the column.
- **`paged` carrier** — `T paged` → `{ items, page, pageSize, total, totalPages }`.
- **`envelope` carrier** — `T envelope` → `{ id, ts, body }`.
- **`option` carrier** — `T option` — tagged option wrapper and its wire `type` tag.
