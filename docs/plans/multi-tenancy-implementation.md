# Multi-tenancy — implementation plan (IN PROGRESS)

> Claim stub. This session is producing the phased implementation plan for
> first-class multi-tenancy from `docs/proposals/multi-tenancy-design-note.md`
> (R1–R5): `tenancy by … of Organization`, the `tenantOwned` prelude capability,
> `crossTenant`, the explicit-stance lint, and registry verification.
> State audit + design review are done; the paper simulation and full plan land
> on this branch next. Touches (planned): `src/language/ddd.langium` (SystemMember
> + Aggregate flag), `src/macros/prelude.ts`, `src/language/validators/tenancy.ts`,
> `src/ir/{types,lower,validate}`, docs. No backend emitter work in Phase 1.
