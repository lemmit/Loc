# Encrypted-at-rest field modifier — `encryptedAtRest`

> Status: deferred. Reserved as a *future, separate* feature so it
> isn't conflated with [`sensitive`](./sensitivity-and-compliance.md).

## Why this is its own feature, not part of `sensitive`

`sensitive(<tag>)` governs **information flow**: who can see the
value, in what context, and how it appears on the wire / in logs / in
UI. It is a *type-system* concern (the value's sensitivity rides on
its `DddType` and propagates through expressions; sinks like `log`
require non-sensitive arguments).

`encryptedAtRest` governs **persistence**: how the column is stored in
the database, what key encrypts it, what searches are still possible
against it. It is a *storage layer* concern (it lives in the EF model
attribute, an Ecto field type / changeset cast, or a column-level
encryption wrapper).

The two are orthogonal:

| field | `sensitive` | `encryptedAtRest` |
|---|---|---|
| `email` | yes (pii) | no (we filter by it often) |
| `ssn` | yes (pii) | yes |
| `legacyApiKey` | yes (cred) | yes |
| `birthDateInCalendarFormat` | no | yes (org policy) |
| `name` | no | no |

A field can be either, both, or neither. Conflating them would force
"sensitive ⇒ encrypted" and "encrypted ⇒ sensitive", both of which
have real-world counterexamples.

## Sketch (non-binding)

A trailing property modifier alongside `sensitive`:

```ddd
aggregate Patient {
  id:        Patient id
  email:     string sensitive(pii)
  ssn:       string sensitive(pii) encryptedAtRest
  diagnosis: string sensitive(phi) encryptedAtRest
}
```

Open considerations for the eventual proposal:

- **Key management** — per-aggregate key vs per-tenant key vs
  per-column key; key-rotation story.
- **Search/filter implications** — equality search requires
  deterministic encryption (or a hashed index column); range/LIKE
  search generally impossible. Repository find declarations against
  encrypted fields need a compile-time error or a documented
  blind-index escape hatch.
- **Backend support matrix** — EF Core has column-level encryption via
  value converters; Elixir/Ecto via a custom `Ecto.Type` (e.g. Cloak)
  or `pgcrypto`; Postgres `pgcrypto` for raw SQL; Hono/Drizzle has no
  first-class story today.
- **Test fixtures** — generated seed data must round-trip through the
  encryption layer.

## Not in scope here

This file exists only to **park the idea** so a future implementer
doesn't fold it into the `sensitive` feature. When the feature comes
up for design, this stub gets replaced by a full proposal in the same
shape as the other docs under `docs/old/proposals/`.
