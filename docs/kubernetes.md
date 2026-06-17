# Kubernetes / Helm deployment

`ddd generate system --k8s` emits a Helm chart (`helm/`) and the raw
manifests it renders to (`k8s/`) **alongside** the always-present
`docker-compose.yml`. Compose stays the inner-loop story
(`docker compose up` boots the whole stack against an in-container
postgres); the chart is the cluster story.

```bash
ddd generate system app.ddd -o out          # compose only (default)
ddd generate system app.ddd -o out --k8s    # + helm/ + k8s/
```

The switch is **additive**: it never replaces the compose file. This is an
**emitter-only** feature — nothing in the `.ddd` grammar or the IR changes.
Every infra knob the DSL doesn't model (replicas, resources, ingress host,
image registry, DB connection string) has a home in the chart's
`values.yaml`, overridden per environment with `--set` / `-f values.prod.yaml`.

## What gets emitted

```
out/
  docker-compose.yml          # unchanged — the inner loop
  helm/
    Chart.yaml
    values.yaml               # the tuning seam (see below)
    templates/
      _helpers.tpl            # name / label helpers
      <name>-deployment.yaml  # one per deployable
      <name>-service.yaml     # one per deployable (ClusterIP)
      <name>-config.yaml      # non-secret env (ConfigMap)
      <name>-ingress.yaml     # UI-serving deployables, gated on values
      secret.yaml             # DB connection + sensitive env (one Secret)
      NOTES.txt
  k8s/                        # the same chart rendered with its defaults
    <name>-deployment.yaml
    <name>-service.yaml
    <name>-config.yaml
    secret.yaml
```

Resource names are DNS-1123 (`webApp` → `web-app`); the Helm `values.yaml`
keys and `--set` paths use the deployable's original identifier (`webApp`).

## How a deployable maps onto a workload

Each deployable's k8s workload is derived from exactly the data the compose
path already reads — `PlatformSurface.composeService` + `DeployableIR` — so
the two stay structurally aligned:

| Source | k8s |
|---|---|
| `internalPort` | container `port` + `Service.targetPort` |
| deployable `port` | `Service.port` |
| `/ready` on DB backends, `/` on frontends | `readinessProbe` |
| `/health` on DB backends, `/` on frontends | `livenessProbe` |
| non-secret `env` | `ConfigMap` (via `envFrom`) |
| DB-connection + sensitive `env` | `Secret` ref (`secretKeyRef`) |
| frontend / UI-serving | optional `Ingress` (off by default) |

**Probes are aligned across backends.** Every DB-backed backend
(hono / .NET / Python / Java / Phoenix) emits *both* a cheap `/health`
(no DB) and a DB-aware `/ready` (pings the database), so the emitter uses a
uniform rule — `livenessProbe: /health`, `readinessProbe: /ready` — rather
than the deployable's `healthPath` (which reflects each backend's *compose*
healthcheck choice and would otherwise leak a non-DB-aware readiness probe
for Phoenix). `/ready` backing readiness means a transient DB outage gates
traffic instead of restarting the pod. Frontends expose neither endpoint, so
both probes hit the static root `/`.

**Secrets stay out of the ConfigMap.** The DB connection string is routed to
the `Secret` (it points at the `db` host), and so is any env whose name looks
sensitive — `*PASSWORD*`, `*SECRET*`, `*TOKEN*`, `*KEY_BASE*`, … This catches
Java's `SPRING_DATASOURCE_PASSWORD` and Phoenix's `SECRET_KEY_BASE`; only
non-sensitive config (`PHX_HOST`, `PORT`, `SPRING_DATASOURCE_USERNAME`, …)
lands in the plaintext `ConfigMap`. The classifier is a name heuristic in v1;
the principled version — each backend *declaring* its secret env via a
`workloadShape()` peer to `composeService` — is the deferred follow-up below.

## `values.yaml` — the tuning seam

```yaml
global:
  image:
    registry: ""          # set to your registry; empty ⇒ local <name>:<tag>
    tag: latest
    pullPolicy: IfNotPresent
ingress:
  className: ""
  host: ""

api:                      # one block per deployable
  replicas: 1
  resources: { requests: {...}, limits: {...} }
  env: {}                 # extra env overlaid onto the ConfigMap
  database:
    url: "postgres://…@db:5432/api"   # placeholder — point at your managed DB
  secrets: {}             # sensitive env (only present when the backend has any),
                          # e.g. SECRET_KEY_BASE / SPRING_DATASOURCE_PASSWORD
webApp:
  replicas: 1
  resources: { ... }
  env: {}
  ingress: { enabled: false, host: "" }
```

Backends default to a heavier resource class than static frontends. The DB
`database.url` defaults to the dev-compose connection string as a recognisable
**placeholder** — production overrides it with the real managed-DB URL.

## Decisions (v1)

- **D-K8S-FORMAT** — Helm chart is the primary deliverable; the raw `k8s/`
  manifests are the default-values render (the fallback view).
- **D-K8S-SCOPE** — emitter-only. No grammar/IR change; per-deploy tuning
  lives in `values.yaml`.
- **D-K8S-DB** — external / managed database. The chart emits a connection
  `Secret` (placeholder) + a `values.yaml` slot; there is **no** in-cluster
  postgres `StatefulSet`. The compose path keeps its in-container postgres
  for the inner loop. The same `Secret` also holds any other sensitive env
  (passwords / app secret keys), kept out of the plaintext `ConfigMap`.
- **D-K8S-INGRESS** — one optional `Ingress` per UI-serving deployable,
  host/className from `values.yaml`, **off by default**. Backends are
  `ClusterIP`.

## Seams this does NOT cover (v1)

- **Image build/push.** Loom emits Dockerfiles, not a registry push. The
  chart references `<registry>/<name>:<tag>`; build and push the images, then
  `--set global.image.registry=… global.image.tag=…`. (Frontend `VITE_*` env
  is baked into the static bundle at build time, so it must be set when the
  image is built, not at install.)
- **Secret values.** Only references + placeholders; the DB URL and any auth
  secrets are supplied at install time.
- **Structural secret classification.** v1 classifies sensitive env by a name
  heuristic; the authoritative version is each backend *declaring* its secret
  env via a `workloadShape()` peer to `composeService` (so a secret with an
  unconventional name isn't missed). Deferred.
- **Deferred:** infra-in-DSL clauses (`replicas` / `resources` / `ingress` on
  `Deployable`), per-platform workload defaults, in-cluster postgres,
  HPA/autoscaling, NetworkPolicy, securityContext hardening, Kustomize
  overlays, CI pipeline generation. See
  [`proposals/kubernetes-helm.md`](proposals/kubernetes-helm.md) §6.

## Implementation

Two sibling emitters under `src/system/`, wired into `emitSystem` next to
`renderDockerCompose` and gated on the `emitKubernetes` option:

- `src/system/kubernetes.ts` — owns the shared `WorkloadModel`
  (`buildWorkloads`) and `renderKubernetesManifests` (raw YAML).
- `src/system/helm.ts` — `renderHelmChart`, consuming the same
  `WorkloadModel` so the chart and raw manifests never drift.
