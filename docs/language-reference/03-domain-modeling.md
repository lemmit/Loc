# 3. Domain modeling

> **Grammar:** `Aggregate`, `ValueObject`, `EntityPart`, `EventDecl`, `EnumDecl`, `Property`, `Containment` · **Validators:** `loom.bare-aggregate-in-type`, scope provider in `src/language/ddd-scope.ts` · **Docs:** [`../language.md`](../language.md)

The core building blocks: `aggregate` roots (and their header modifiers), `valueobject`s, nested `entity` parts and `contains`, `event`s, `enum`s, and the field grammar with its access modifiers.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`aggregate`** — root with implicit `Name id`; header modifiers `ids`, `persistedAs`, `shape`, `inheritanceUsing`. Show the emitted table + DTO.
- **`valueobject`** — immutable record; no table/repo of its own; how it persists inside a parent.
- **`entity` parts & `contains`** — nested part on a child table joined on parent_id; `contains X[] | X | X?`.
- **`event`** — flat record raised via `emit`; the emitted event type.
- **`enum`** — closed enumeration; bare value references; wire representation.
- **Fields (`Property`)** — `name: Type [= default] [check Expr]`; defaults and inline checks.
- **Access modifiers** — `editable` (default), `immutable`, `managed`, `token`, `internal`, `secret` — effect on DTO/route/wire.
- **`sensitive(...)`** — tagging (`pii`/`phi`/`cred`/`audited`) and its downstream effect.
