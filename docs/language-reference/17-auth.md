# 17. Authentication & authorization

> **Grammar:** `user`, `auth`, `permissions`, `requires`, `sensitive` · **Validators:** auth enforcement checks · **Docs:** [`../auth.md`](../auth.md)

Identity and access: the `user` JWT claim shape, the `auth` OIDC config, the per-subdomain `permissions` catalogue, the `requires` authorization guard, `currentUser`, and `sensitive` field tagging.

> **Status:** stub — content pending. Author this chapter per
> [`AUTHORING.md`](AUTHORING.md): one section per feature below, each with
> an isolated `.ddd` snippet and its **real generated output** in platform
> tabs. Remove this banner when filled.

## Features to document

- **`user`** — JWT claim shape decoded by verifiers; one per system.
- **`auth`** — OIDC config: provider/oidc/sessions/claims/enforcement.
- **`permissions`** — per-subdomain catalogue; `permissions.<name>` lowering to `"<subdomain>.<name>"`.
- **`requires`** — authorization guard (→ 403) in operations/workflows/views.
- **`currentUser`** — claim access in domain logic.
- **`sensitive(...)`** — pii/phi/cred/audited tagging and downstream handling.
