# `ValueSource` — generalize connection provenance to auth (and beyond)

*Design note building directly on [`connection-secret-wiring`](../../old/proposals/connection-secret-wiring.md)
— it **answers that proposal's Open Question #4** ("unify the auth/OIDC
client-secret wiring under `ConnectionSource`?") with the vision developed in a
design conversation. Status: **design proposal — not built.** Grounded in the
real grammar; no invented syntax. Verify against fresh `main` before building.*

## The real state today (verified)

Loom already has a provenance vocabulary — but only for storage connections, and
it's inert:

- **`ConnectionSource`** (on `storage { connection: … }`): a 4-way source —
  **`service(id)` | `env("VAR")` | `secret(name)` | `literal("…")`**. It lowers to
  `ConnectionSourceIR` but **no emitter consumes it** — the deployment wiring is
  the whole subject of `connection-secret-wiring` (compose `secrets:`/`env_file`,
  k8s `Secret`/`secretKeyRef`; phases P1–P4).
- **`AuthConfigValue`** (on `auth { oidc { issuer/clientId/clientSecret/audience:
  … } }`): only **`literal | env("VAR")`** — it **lacks the `secret()` and
  `service()` arms** `ConnectionSource` has.
- **`config: { key: value }`** blocks (on `storage` + the `dataSource` binding):
  values are **literals only** (`STRING | INT | BOOL`) — no `env()`.

So the same idea — "where does this value come from" — is spelled three different
ways, at three levels of completeness.

## The gap this exposes: auth can't say `secret()`

Auth values differ in sensitivity, but the grammar can't express it:

| auth value | secret? | wants | can today? |
|---|---|---|---|
| `issuer` | no — public OIDC endpoint, per-env | `env()` | ✓ |
| `clientId` | no — public identifier | `env()` | ✓ |
| `audience` | no — public token identifier | `env()` | ✓ |
| `clientSecret` | **yes — a credential** | **`secret()`** | ✗ — only `env()`/`literal()` |

The one auth value that *is* a secret can't be sourced as one. Today the OIDC
client secret is at best `env("OIDC_CLIENT_SECRET")` (a plain env var — out of
source, good; but no secret-store wiring, no sensitivity classification) or, worse,
a `literal` baked into source. `connection-secret-wiring` already injects this
secret somehow (D-AUTH-OIDC) — but not through a declared, wired `secret()`.

## The vision: one `ValueSource`

Lift the `ConnectionSource` 4-way vocabulary into a shared **`ValueSource`**
(`literal | env | secret | service`) usable wherever a deploy-time value comes
from — **starting with auth**, which is exactly OQ#4:

```ddd
auth { oidc {
  issuer:       env("OIDC_ISSUER")          // public config, per-env
  clientId:     env("OIDC_CLIENT_ID")
  audience:     env("OIDC_AUDIENCE")
  clientSecret: secret("oidc-client-secret") // ← now expressible: a real secret
} }

storage db { type: postgres, connection: secret("app-db-url") }   // already parses
```

Two things fall out cleanly:

1. **Sensitivity derives from the source kind — no separate annotation.**
   `secret(...)` auto-classifies its value as **sensitive** (never logged, masked
   if it leaks), plugging into the M-T3.8 sensitivity system *and* the proposal's
   P4 redaction guard. `env()` / `literal()` / `service()` are not sensitive by
   default. So `clientSecret: secret(...)` *is* the secrecy declaration — you don't
   also tag it.
2. **One wiring path.** The OIDC client secret rides the **same** emission machinery
   `connection-secret-wiring` builds for `storage` — k8s `secretKeyRef` (P2),
   compose `secrets:`/`*_FILE` (P3) — instead of a bespoke auth injection. A
   `secret()` is a `secret()` wherever it appears.

## Emission — reuse the proposal's matrix verbatim

No new emission design; a `ValueSource` at any site emits exactly the
`connection-secret-wiring` matrix (§Emission design):

| source | compose | k8s / Helm |
|---|---|---|
| `secret(n)` | `secrets:` + `*_FILE`, value from un-committed `.env` | `valueFrom.secretKeyRef{name,key}` + a chart `Secret`/`existingSecret` knob |
| `env(N)` | `environment: [N]` passthrough | env `name: N` passthrough |
| `service(id)` | sidecar service URL (dev default) | Service DNS |
| `literal(s)` | inline (warned `loom.*-literal-secret`) | inline (warned) |

`secret(...)` is **never inlined** into a committed artefact — the proposal's hard
rule, now applying to the auth client secret too.

## Sequencing — ride the proposal, don't race it

The grammar change is cheap; the **deployment wiring is the multiplying cost**, so
the generalization is *staged behind* the proposal's machinery, not ahead of it:

1. **connection-secret-wiring P1–P2** build the env-naming + k8s `secretKeyRef` +
   chart `Secret` machinery for `storage`. (Prerequisite.)
2. **Auth unification (this note's core):** give `AuthConfigValue` the `secret()`/
   `service()` arms — i.e. make it a `ValueSource` (shared grammar fragment, not a
   copy) — and route the OIDC client secret through the same `secretKeyRef` path.
   Small extension once P2 exists; closes OQ#4.
3. **P3–P4** (compose secrets + redaction guard) then cover auth for free — same
   `secret()`, same guard.

## Scope discipline (staying grounded)

- **Not everything becomes a `ValueSource`.** It's *available* where per-env
  variance or secrecy is real (connections, auth); most values stay literals. Do
  not open it at ten sites before one reaches a real Secret.
- **Other candidate sites are flagged, NOT designed here:** `config: {}` values
  (allow `env()`?), deployable `port:`, a job cadence (the M-T4.6 open item),
  feature flags. Each is a *possible* later extension of the same `ValueSource`,
  each carrying its own emission cost. None is in scope for this note.
- **`literal()` stays dev-only** for secret-bearing values (warned), per the
  proposal.

## Open questions

Inherits the proposal's OQ1–3 (generate vs reference an existing `Secret`;
per-resource vs shared secret; `secret()` on compose-only → `env_file` degrade).
New to the generalization:

1. **Grammar mechanics** — share one `ValueSource` rule across `ConnectionSource`
   and `AuthConfigValue` (rename/alias `ConnectionSource → ValueSource`, keep the
   old name as an alias for byte-stability), or a common fragment both include?
2. **`config: {}` values** — do they gain `env()`/`secret()` in this pass, or stay
   literals until a concrete need? (Lean: stay literals; widen on demand.)
3. **Sensitivity default** — confirm `secret()`-derived-sensitive is automatic and
   cannot be down-classified without an explicit `authorized(...)` (M-T3.8), so a
   client secret can't be logged by omission.

## Mission mapping

- **Foundation:** `connection-secret-wiring` (P1–P4) — the deployment-wiring
  machinery; this note's auth unification is stage 2 between its P2 and P3.
- **M-T3.8** (sensitivity) — `secret()`-derived classification + the redaction
  guard (P4) integrate here.
- **D-AUTH-OIDC** — the existing OIDC client-secret injection this replaces with a
  declared, wired `secret()`.
- Likely home: a T7 (deployment) or T3 (governance) mission once the proposal is
  scheduled; not yet mission-numbered.
