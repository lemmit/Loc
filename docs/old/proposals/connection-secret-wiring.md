# Proposal — wire `connection:` secret/env sources into generated deployments

**Status:** draft (2026-07-19) · **Size:** L · **Depends on:** the resource model
(`resource-model-and-source-types.md`), the mailer credentials slice
(`email-resource-kind.md` §credentials).

## Problem

Infrastructure credentials — the database `DATABASE_URL`, the mailer `MAIL_URL`
(now carrying `smtp://user:pass@relay`), the queue `amqp://…`, provider keys
(`SENDGRID_API_KEY`, AWS creds) — are read from **environment variables at
runtime**, which keeps them out of `.ddd` source (good, 12-factor). But there is
**no first-class way to declare where a credential comes from and have Loom wire
it into the generated deployment**:

- The generated `docker-compose.yml` sets **no** `MAIL_URL` (only the dev
  Mailpit sidecar); the DB `DATABASE_URL` is derived per-deployable. For
  production the *operator* must inject the real, secret-bearing values through
  their own out-of-band mechanism.
- There is no generated Kubernetes `Secret` / `secretKeyRef`, no compose
  `secrets:` / `env_file:` — so a secret has nowhere declared to live.
- The grammar for exactly this **already exists but is inert**:

  ```
  Storage:          'storage' name '{' 'type' ':' StorageType
                        ('connection' ':' ConnectionSource)? ('config' … )? '}'
  ConnectionSource: service(ID) | env(STRING) | secret(ID) | literal(STRING)
  ```

  It lowers to a `ConnectionSourceIR` (`kind: service | env | secret | literal`)
  and is validated, **but no backend/system emitter consumes it** — an honest gap
  documented in `docs/language-reference/14-apis-storage-resources-channels.md`.

Net: credentials are secret-*ish* (out of source, in env), but Loom does not
manage them — the last mile is manual and inconsistent per deployment target.

## Goal

Make `connection:` the single, declarative source-of-truth for **where** a
store's connection string / credential comes from, and emit the correct wiring
into every deployment artefact — compose, Kubernetes/Helm, and the per-deployable
env — so nothing sensitive is inlined into a committed file and nothing is
injected ad hoc.

Applies uniformly to every credential-bearing store: `postgres`/`mysql`
(`DATABASE_URL`), `smtp`/`ses`/`sendgrid` (`MAIL_URL` / provider key),
`rabbitmq` (`amqp://`), `s3`, `restApi`.

## Surface (already parses)

```ddd
storage db     { type: postgres, connection: secret("app-db-url") }
storage mailer { type: smtp,     connection: secret("smtp-url"), config: { from: "no-reply@acme.test" } }
storage crm    { type: restApi,  connection: env("CRM_TOKEN") }
storage devpg  { type: postgres, connection: literal("postgres://dev:dev@db:5432/app") }  // dev only
```

- `secret(name)` — the value lives in a named secret store; Loom emits a
  **reference**, never the value.
- `env(NAME)` — the value comes from an ambient env var the operator sets; Loom
  emits the passthrough (no value).
- `service(id)` — derived from a compose/k8s service handle (the existing
  dev-default behaviour, made explicit).
- `literal(str)` — inline; **dev-only**, gated behind a validator warning
  (`loom.connection-literal-secret`) because it bakes a value into a committed
  artefact.

The **env-var name** each backend reads is decoupled from the current hardcoded
`<RESOURCE>_URL` convention: `connection:` names it (defaulting to today's
`<RESOURCE>_URL` when omitted, so existing models stay byte-identical).

## Emission design

Per credential-bearing resource on a deployable, given its store's
`ConnectionSourceIR`:

| source | docker-compose | Kubernetes / Helm | dev fallback |
|---|---|---|---|
| `secret(n)` | `secrets:` entry + `env_file` / `_FILE` convention, value from `.env`/external | container env `valueFrom.secretKeyRef{name,key}` (referencing a pre-created or Helm-`values`-fed `Secret`) | — |
| `env(N)` | `environment: [ N ]` passthrough | env `name: N` passthrough (from the pod's env) | — |
| `service(id)` | derived URL against the sidecar service (today's behaviour) | derived Service DNS | the compose sidecar |
| `literal(s)` | inline value (warned) | inline (warned) | — |

- **Never inline a `secret(...)` value** into `docker-compose.yml` or a rendered
  manifest. k8s uses `secretKeyRef`; compose uses `secrets:`/`*_FILE` so the
  value stays in an un-committed `.env`/secret file.
- The Helm chart grows a `values.yaml` knob per secret (e.g.
  `secrets.appDbUrl`) that maps to a `Secret` (created by the chart, or an
  `existingSecret` reference), consumed via `secretKeyRef`.
- **Redaction:** guarantee no backend logs the resolved URL/credential. Add an
  obs/test guard (grep the emitted log-call sites for the connection vars) so a
  future change can't leak a password into a log line. The current mailer code
  already avoids this; the guard freezes it.

## Phasing

1. **P1 — env-var naming.** Consume `connection: env(NAME)` to override the
   hardcoded `<RESOURCE>_URL` env-var name on all five backends + the mailer.
   Purely a naming indirection; no manifest change. Unlocks "point at an existing
   env var" without new infra.
2. **P2 — Kubernetes secrets.** `secret(n)` → `secretKeyRef` in the Deployment +
   a chart `Secret`/`existingSecret` knob (`docs/kubernetes.md` surface). The
   `k8s-build` gate renders + `kubeconform`s it.
3. **P3 — compose secrets.** `secret(n)` → compose `secrets:` + `*_FILE`; keep
   `service(...)` sidecar default for dev.
4. **P4 — redaction guard + docs.** The no-log test guard; document the full
   matrix in `resources.md` + `docs/kubernetes.md`.

## Security notes

- A password embedded in a URL env var carries the usual env-var exposure
  (process listing, child-process inheritance, accidental logging). `secret(...)`
  + `secretKeyRef` narrows this to the k8s Secret's RBAC surface; the redaction
  guard covers the logging vector.
- `literal(...)` bearing a credential should warn (dev convenience only).
- Out of scope: a secrets *manager* integration (Vault/SSM/Secrets Manager
  fetch-at-boot). `secret(n)` here is a reference to a k8s Secret / env-file, not
  a live fetch. A manager-backed `ConnectionSource` variant could layer on later.

## Open questions

1. **Generate the `Secret` vs reference an existing one.** Default to an
   `existingSecret` reference (operators usually manage secrets out-of-band),
   with an opt-in "chart creates the Secret from `values`" for quick starts?
2. **Per-resource vs shared secret.** One Secret with many keys vs one per
   store. Lean per-store key in a shared `<app>-secrets` Secret.
3. **`env` vs `secret` for compose.** Compose has no RBAC; `secret(...)` there is
   really an `env_file`/`*_FILE` convention. Should `secret(...)` on a
   compose-only deployment degrade to `env_file` with a note, or require k8s?
4. Interaction with the auth/OIDC client-secret wiring (D-AUTH-OIDC already
   injects an OIDC client secret) — unify both under `ConnectionSource`?

## Why now

The mailer credentials slice (`email-resource-kind.md`) made SMTP authenticate
from `MAIL_URL` on all five backends, which sharpened the question: the
credential is correctly kept out of source and read at runtime, but Loom still
doesn't *own* its delivery into the deployment. Wiring `connection:` is the
honest completion of that story, and it pays off for **every** credential-bearing
store, not just the mailer.
