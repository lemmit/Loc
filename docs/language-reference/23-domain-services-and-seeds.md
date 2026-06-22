# 23. Domain services & seeds

> **Grammar:** `DomainService`, `Seed` · **Validators:** no-infra contract; seed shape checks · **Docs:** [`../domain-services.md`](../domain-services.md)

Two smaller context-level declarations: `domainService`, a stateless pure cross-aggregate calculator with a no-infrastructure contract, and `seed`, declarative first-boot data (including table-level `raw` inserts).

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`domainService`** — stateless pure calculator; no infra; per-backend emission of its operations.
- **`seed`** — declarative first-boot data; the emitted seeding.
- **`seed ... raw`** — table-level inserts for data the domain model does not own.
