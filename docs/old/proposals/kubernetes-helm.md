# Proposal: Kubernetes / Helm as a deployment target

**Status:** Adopted and shipped (v1, emitter-only). The reference doc is
[`docs/kubernetes.md`](../../kubernetes.md); the two non-goal statements called
out below have been updated. This file is kept as the design rationale.
**Scope:** Emit a Helm chart (and the raw manifests it renders to) alongside
the existing `docker-compose.yml`, so a generated Loom system can be deployed
to a Kubernetes cluster. **Emitter-only** — no `.ddd` grammar or IR change in
v1. Database is assumed **external / managed** (RDS, Cloud SQL, …); the chart
emits a connection `Secret`, not an in-cluster postgres.

> This reverses a previously-stated non-goal. Two docs currently say Loom does
> not emit k8s manifests:
>
> - `docs/tools.md:324` — *"Loom does **not** generate k8s manifests or CI
>   pipelines — those are project-init concerns, not derived from the `.ddd`
>   source."*
> - `docs/generators.md:764` — lists "Generated CI / k8s manifests" as a
>   non-goal, but adds *"addressable as either generator extensions or
>   `.loomignore`-pinned customizations."*
>
> This proposal takes the "generator extension" path that the second note
> already names. Both docs should be updated when this lands.

---

## 1. Background and motivation

Docker Compose is the only operational artifact Loom emits today. It is a
great inner-loop story (`docker compose up` boots the whole multi-deployable
stack) but it is not how anyone runs the system in production. The most common
production target is Kubernetes, and the most common packaging for a
Kubernetes app is a Helm chart.

The good news from the architecture audit: **the system orchestrator already
treats deployment output as a pluggable artifact layer, and the platform
metadata it reads is almost exactly what a k8s workload needs.** Adding Helm is
additive, not invasive.

---

## 2. How deployment is emitted today (verified)

Compose is **system-level orchestration**, not platform codegen. It lives in
`src/system/index.ts` as one of ~12 sibling artifact emitters called from
`emitSystem` (`index.ts:138–161`):

```ts
out.set("docker-compose.yml", renderDockerCompose(sys));
out.set("db-init/00-create-databases.sql", renderDbInit(sys));
out.set(".loom/wire-spec.json", renderWireSpec(sys));
out.set(".loom/deployment.mmd", renderDeploymentDiagram(sys));
// … mermaid views, LikeC4, datasources.md
```

`renderDockerCompose` (`index.ts:310`) writes a `db` postgres service, loops
`sys.deployables` through `renderDeployableService` (`index.ts:403`), then
appends storage sidecars (`renderStorageSidecars`, `index.ts:358`) for
`awsS3`→minio / `rabbitmq`.

Per-deployable, the **only** thing it asks the platform for is a
`ComposeServiceShape` (`src/platform/surface.ts:30`) via
`platform.composeService({ deployable, sys, slug })` (`index.ts:406`):

```ts
interface ComposeServiceShape {
  env: Array<[string, string]>;   // ordered for stable yaml
  dependsOnDb: boolean;            // → depends_on: db { condition: service_healthy }
  healthPath: string;             // → healthcheck path
  internalPort: number;           // → container port
  // reserved, undefined on every backend today:
  auditSidecar?; policyInitCmd?; i18nCatalogDir?;
}
```

The emitted service (`index.ts:407–432`) is just `build:`, `depends_on`,
`environment`, `ports: "<hostPort>:<internalPort>"`, and a `wget` healthcheck.

`DeployableIR` (`src/ir/types/loom-ir.ts:1385`) carries `platform`, `contexts`,
`dataSources`, `port`, `targetName`, `design`, `auth`, `serves`, `ui*`,
`favicon` — and **no infra knobs** (no replicas / resources / ingress /
secrets). The DSL `Deployable` rule (`src/language/ddd.langium`) matches.

### Why a k8s emitter needs almost no new model

`ComposeServiceShape` + `DeployableIR` map nearly 1:1 onto a k8s workload:

| `ComposeServiceShape` field | k8s equivalent |
|---|---|
| `internalPort` | container `ports[].containerPort` + `Service.targetPort` |
| `env` | container `env[]` (and `ConfigMap`/`Secret` refs) |
| `healthPath` | `livenessProbe` + `readinessProbe` `httpGet.path` |
| `dependsOnDb` | init container / connection `Secret` presence |
| `DeployableIR.port` | `Service.port` |
| `DeployableIR.targetName` | frontend → backend `Service` DNS for ingress/env |

So a baseline chart is derivable **with zero IR change** — the value of an
emitter-only v1.

One forward-looking signal: `ConnectionSourceIR` already has a `secret(handle)`
variant, described in `docs/old/proposals/storage-and-platform-config.md` as
"secret manager (k8s, Vault, AWS)". The DB-connection-as-`Secret` story is
already anticipated by the IR.

---

## 3. Decisions for v1

| Decision | Choice | Rationale |
|---|---|---|
| **D-K8S-FORMAT** | Helm chart is the primary deliverable; the rendered raw manifests are the fallback view. | Matches the request ("charts/helm files"); `values.yaml` is the tuning seam that keeps the DSL clean. |
| **D-K8S-SCOPE** | Emitter-only. No grammar/IR change. Defaults baked in; per-deploy tuning lives in `values.yaml`. | Ships fast, zero pipeline churn, no breaking change. Infra-in-DSL (replicas/resources) is a deferred follow-up. |
| **D-K8S-DB** | External / managed DB. Chart emits a connection `Secret` + `values.yaml` placeholder; **no** in-cluster postgres StatefulSet. | Production-leaning; aligns with the `secret()` connection source; avoids stateful-workload + PVC complexity in v1. The compose path keeps its in-container postgres for the inner loop. |
| **D-K8S-INGRESS** | One optional `Ingress` per frontend deployable, host/path from `values.yaml`, off by default. | Backends are `ClusterIP`; only the UI needs external exposure by default. |

**Explicit non-goals for v1:** HPA/autoscaling, NetworkPolicy, PodSecurity /
securityContext hardening, in-cluster postgres, Kustomize overlays, CI
pipeline generation, secret *values* (only references + placeholders).

---

## 4. Proposed implementation (Option A)

Two new sibling emitters under `src/system/`, mirroring `renderDockerCompose`:

- `src/system/kubernetes.ts` → `renderKubernetesManifests(sys): Map<string,string>`
  emitting raw YAML under `k8s/`.
- `src/system/helm.ts` → `renderHelmChart(sys): Map<string,string>`
  emitting a chart under `helm/`.

Both reuse `serviceSlug` (`index.ts:302`) and read `platformFor(d.platform)
.composeService(...)` exactly as the compose path does. Wired into
`emitSystem` next to the compose `out.set` calls, gated by a CLI surface so
existing `generate system` output is unchanged unless opted in.

### 4.1 Helm chart layout

```
helm/
  Chart.yaml                 # name = <system>, version 0.1.0
  values.yaml                # per-deployable block + global image/registry/db
  templates/
    _helpers.tpl             # name/label helpers
    <slug>-deployment.yaml   # one per deployable
    <slug>-service.yaml      # one per deployable (ClusterIP)
    <slug>-ingress.yaml      # frontend deployables only, gated on values
    db-secret.yaml           # external DB connection string (Secret)
    config.yaml              # non-secret env as ConfigMap
  NOTES.txt
```

### 4.2 `values.yaml` shape (the tuning seam)

```yaml
global:
  image:
    registry: ""          # e.g. ghcr.io/acme
    tag: latest
    pullPolicy: IfNotPresent
database:
  external: true
  # connection string supplied at install: --set database.url=...
  url: ""
ingress:
  enabled: false
  className: ""
  host: ""

ordersBackend:            # one block per deployable (serviceSlug)
  replicas: 1
  resources:
    requests: { cpu: 100m, memory: 256Mi }
    limits:   { cpu: 500m, memory: 512Mi }
  env: {}                 # extra env overlays
webApp:
  replicas: 1
  ingress: { enabled: false, host: "" }
  resources:
    requests: { cpu: 50m,  memory: 128Mi }
    limits:   { cpu: 250m, memory: 256Mi }
```

Defaults are baked into the rendered `values.yaml`; production overrides are
`--set`/`-f values.prod.yaml`. This is what keeps v1 emitter-only: every infra
knob the DSL doesn't model has a home in `values.yaml`.

### 4.3 Deployment template (sketch)

For each deployable, the platform's `composeService` shape drives the spec:
`internalPort` → `containerPort`, `env` → `env[]` (DB entries rewritten to
`secretKeyRef` against `db-secret`), `healthPath` → liveness + readiness
`httpGet`. `dependsOnDb` deployables get the DB `Secret` mounted; no
init-container wait is needed against a managed DB (the app's existing
`/ready` readiness probe gates traffic until the connection is up).

### 4.4 CLI surface

Recommend a flag on the existing system generator rather than a new verb:

```
ddd generate system app.ddd -o out --emit helm        # + k8s/ raw render
ddd generate system app.ddd -o out --emit compose,helm # both
```

Default stays `compose` so nothing changes for current users.

---

## 5. Testing & docs alignment

- **Snapshot tests** in `test/system/` over the emitted `Map`, mirroring the
  existing compose tests — deterministic YAML, byte-stable.
- **Opt-in slow suite** `LOOM_K8S_BUILD=1` (`npm run test:k8s`) running
  `helm lint`, `helm template`, and `kubeconform`/`kubeval` against the
  rendered output — same gating pattern as `test:dotnet` / `test:phoenix`.
  Add a `k8s-build.yml` CI workflow alongside the per-backend build gates.
- Update the two non-goal statements (`docs/tools.md:324`,
  `docs/generators.md:764`) and add `docs/kubernetes.md` to the doc index in
  `docs/README.md`.

---

## 6. Deferred (future proposals)

- **Infra-in-DSL (Option B):** optional `Deployable` clauses `replicas`,
  `resources { cpu/memory }`, `ingress { host, path }`, `secrets [...]`,
  threaded into `DeployableIR` so infra intent is modelled, diffable, and
  traceable — and so the compose path can emit `deploy.resources` too. Follows
  the CLAUDE.md "adding a language feature" recipe (grammar →
  `langium:generate` → scope/validate → IR node → lower → per-backend tests).
- **Per-platform workload defaults (Option C):** a `composeService`-peer
  `workloadShape(args)` on `PlatformSurface` so each backend states its own
  resource class / probe tuning (`.NET` heavier than a static frontend,
  Phoenix needs `SECRET_KEY_BASE` as a real `Secret`). The reserved-hook block
  at `surface.ts:160–214` is the structural precedent.
- In-cluster postgres StatefulSet + PVC (dev-cluster convenience), Kustomize
  overlays, HPA, NetworkPolicy, securityContext hardening.

---

## 7. Open risks

- **Image build/publish is out of scope.** The chart references
  `registry/<slug>:<tag>` but Loom emits Dockerfiles, not a registry push — so
  the chart is only usable after the user wires CI to build/push images.
  Document this seam clearly in `NOTES.txt`.
- **Secret values are never generated.** Only references + empty placeholders;
  the DB URL and any auth secrets are supplied at install time.
- **Reversing a stated non-goal** is a product stance change, not just code —
  the two doc edits in §5 are mandatory, not optional.
