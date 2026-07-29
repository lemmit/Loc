# T7 — Deployment & operations

*Observability now ships the full trio on all five backends — a log catalog, Prometheus `/metrics` (with per-operation/domain-fault counters + a compose/k8s Prometheus collector), and OpenTelemetry tracing spans (with a bundled Jaeger collector); the Helm chart is a correct scaffold an ops team must finish; networking/proxy designs are approved but unbuilt.*

## M-T7.1 — Metrics + OpenTelemetry — `done` · **L** · P1
Sources: [observability](../old/proposals/observability.md), [observability.md](../observability.md), weak-spots §3, [execution-context](../old/proposals/execution-context.md).

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
