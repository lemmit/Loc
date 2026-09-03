# T7 — Deployment & operations

> **Completed missions for this track live in [`archive/T7-done.md`](archive/T7-done.md)** (1 closed as of 2026-09-02). This file lists only the live missions.

*Observability now ships the full trio on all five backends — a log catalog, Prometheus `/metrics` (with per-operation/domain-fault counters + a compose/k8s Prometheus collector), and OpenTelemetry tracing spans (with a bundled Jaeger collector); the Helm chart is a correct scaffold an ops team must finish; networking/proxy designs are approved but unbuilt.*

## M-T7.2 — k8s production hardening — `partial` · **M** · P2
v1 chart ships (probes, secret/config split, same-origin ingress). Deferred set: TLS/cert-manager, HPA, NetworkPolicy, securityContext, in-cluster postgres option, CI image build/push, Kustomize. Each is additive chart work.
Sources: [kubernetes-helm](../old/proposals/kubernetes-helm.md) deferred list, [kubernetes.md](../kubernetes.md).

## M-T7.3 — Multi-target proxy (same-origin gateway) — `open` · **L** · P2
Approved, unimplemented: `proxy { defaults, routes }` + gateway platforms (caddy first; nginx/traefik/ocelot later), slices 0–9 incl. deleting `targets:` from the grammar (slice 0 — coordinate with [embedded-frontend-composition](../old/proposals/embedded-frontend-composition.md)'s `targets:` validator question).
Sources: [multi-target-proxy](../old/proposals/multi-target-proxy.md).

## M-T7.4 — Deployable networking — `open` · **M** · P3
Port-collision validation + hybrid auto-fill; `serves … at` per-api routing prefixes; frontend per-api path baking; playground multi-backend topology.
Sources: [deployable-networking](../old/proposals/deployable-networking.md).

## M-T7.5 — `ddd dev` + `ddd deploy` (PaaS) — `open` · **L** · P2
The zero-to-running arc: unified dev loop (`ddd dev`), `ddd deploy fly|render|railway` behind a `DeployTarget` contract, npm publish of the CLI.
Sources: [quickstart-and-day-one-batteries](../old/proposals/quickstart-and-day-one-batteries.md) §3.3–3.4.

## M-T7.6 — Terraform / IaC target — `open` · **L** · P3
System-level emitter beside the compose builder (consumes `SystemIR`); needs the missing IR (sizing, scaling, region/ingress, provider). Research-stage — write the concrete proposal first.
Sources: [terraform-iac-target](../old/proposals/terraform-iac-target.md).

## M-T7.7 — Ops/admin surface — `open` · **L** · P3 (proposal needed)
Health/queues/outbox/audit browsing as a generated ops UI (production-readiness §3.9). Depends on M-T7.1 for the data.

## M-T7.8 — Multi-framework-per-host edge — `open` · **S** · P3
The one remaining piece of embedded-frontend composition: one `ui` served by several frameworks / `hosts+=` list; `hostableFrameworks` derivation.
Sources: [embedded-frontend-composition](../old/proposals/embedded-frontend-composition.md).

## M-T7.9 — `connection:` on a `storage` reaches the deployment wiring — `open` · **L** · P1
The clause parses (`ddd.langium:581`), lowers into `StorageIR.connection` (`ConnectionSourceIR`) — and nothing downstream reads it. The **honesty half is already done**: `loom.reserved-not-emitted` (M-T5.9a, `src/ir/validate/checks/reserved-surfaces.ts`, id `storage-connection`) warns on every declaration, naming the real behaviour, so no author can believe the clause is wired. What is left is the wiring.

Today the emitted credential wiring is derived **heuristically from the topology**, not from the declaration: `src/system/kubernetes.ts` classifies a connection-string value as DB-derived iff it embeds the compose `db` host (`…@db:5432/…`, `Host=db;…`), and turns that into the `Secret` reference. So `connection: secret(dbCreds)` and no clause at all emit byte-identical output.

Four surfaces have to consume `StorageIR.connection` together, and two semantic questions have to be settled first (they are why this is a mission and not a check):
1. what `service(x)` means when the compose `db` service is synthesised by the composer anyway; and
2. what happens when the declared source **contradicts** the derived topology — refuse, or let the declaration win.

Then: (a) compose env derivation in `src/system/index.ts`; (b) `src/system/kubernetes.ts` — replace the `Host=db;` heuristic with the declared source, emitting `valueFrom.secretKeyRef{name,key}` for `secret(n)` and a passthrough for `env(N)`; (c) `src/system/helm.ts` db-secret.yaml + values; (d) the per-backend connection-string readers. Gate with a system test asserting the emitted compose/k8s reference NAMES the declared secret/env, mutation-proved by renaming the secret in the fixture. Delete the `storage-connection` row from `RESERVED_SURFACES` in the same PR — it is self-emptying by design.

`literal("postgres://user:pass@…")` deserves its own decision when the wiring lands: a plaintext credential in `.ddd` source is a smell the current warning already calls out, and the wiring is the moment to decide whether it stays legal.

Sources: [connection-secret-wiring](../old/proposals/connection-secret-wiring.md); the 2026-08-30 targets ledger row `connection-secret-wiring` (P0 there on the strength of "no gate", which was stale — M-T5.9a had landed the gate; the wiring is the live half).
