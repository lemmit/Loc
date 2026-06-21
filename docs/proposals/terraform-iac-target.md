# Terraform / Infrastructure-as-Code as a generation target

> Status: **proposal / research**. Nothing here is implemented. This note
> assesses *where* an IaC target fits in Loom's pipeline, *what* IR data
> already supports it, *what* is missing, and a phased recommendation.

## TL;DR

An IaC target is **not a new `PlatformSurface`**. The four registered
platforms (`hono` / `dotnet` / `react` / `phoenixLiveView`) are
*application-code* generators: each emits one project per deployable via
`emitProject` and one service stanza via `composeService`. Terraform is the
*same kind of artifact as `docker-compose.yml`* — a **system-level
composition** that consumes the whole `SystemIR` (every deployable + every
storage + every dataSource) and emits orchestration. It therefore belongs in
`src/system/`, next to `renderDockerCompose` / `renderDbInit` / the `.loom/`
artifact emitters — **not** in `src/platform/registry.ts`.

The IR is already most of the way there: deployables carry platform, port,
hosted contexts, and `serves`/`targets` edges; `SystemIR.storages` already
models `postgres | mysql | redis | elastic | kafka | clickhouse | bigquery |
awsS3 | rabbitmq | restApi` with a `connection` source
(`service(...)` / `env(...)` / `secret(...)` / `literal(...)`) and a generic
`config { … }` vendor-param map. What's missing is **resource sizing,
scaling, region/ingress, and provider selection** — none modelled today.

## 1. How deployment is generated today

`src/system/index.ts:emitSystem` is the whole story. After lowering +
enrichment it:

- emits each deployable's project tree (`platform.emitProject`, prefixed by a
  lowercase service slug),
- writes a single **`docker-compose.yml`** (`renderDockerCompose(sys)`),
- writes **`db-init/00-create-databases.sql`** (one `CREATE DATABASE` per
  `needsDb` deployable),
- and writes the `.loom/` artifact bundle (wire-spec, mermaid views, LikeC4
  model, datasources.md, traceability).

`renderDockerCompose` (`src/system/index.ts:310`) hard-codes a single
`postgres:18-alpine` service, then per deployable calls
`platform.composeService({ deployable, sys, slug })` to get a
`ComposeServiceShape`:

```ts
export interface ComposeServiceShape {
  env: Array<[string, string]>;     // ordered for stable yaml
  dependsOnDb: boolean;             // → depends_on: db (service_healthy)
  healthPath: string;               // → container healthcheck path
  internalPort: number;             // → ports: "<hostPort>:<internalPort>"
  auditSidecar?: ComposeSidecar;    // reserved
  policyInitCmd?: string[];         // reserved
  i18nCatalogDir?: string;          // reserved
}
```

Only two storage kinds today get a sidecar service (`awsS3`→MinIO,
`rabbitmq`→RabbitMQ, in `renderStorageSidecars`). **The rest of the rich
storage/dataSource IR is not yet consumed by compose at all** — `hono`'s
`composeService` returns a hard-coded
`DATABASE_URL=postgres://postgres:postgres@db:5432/${slug}` and `dotnet`
returns a hard-coded `ConnectionStrings__Default=Host=db;…`. Neither reads
`StorageIR.connection` or the `dataSources` bindings.

**Takeaway:** docker-compose *is already an IaC target*. It is a pure
`SystemIR → files` function. A Terraform emitter is the cloud analogue of the
same function, and writing it is the natural forcing-function to make the
storage/connection IR actually load-bearing.

## 2. What the IR already gives an IaC generator

`SystemIR` (`src/ir/types/loom-ir.ts:869`) is a complete deployment plan:

| IR field | IaC use |
|---|---|
| `deployables[]` | one container service / app per deployable |
| `deployable.platform` + `platformRef` | base image / runtime family |
| `deployable.port` | published port / target group |
| `deployable.contextNames` | which schemas/tables the service owns |
| `deployable.serves` / `targets` | service-discovery edges, ingress routes |
| `deployable.auth` | whether the service needs JWT/secret wiring |
| `PlatformSurface.needsDb` | whether to provision a DB for the service |
| `PlatformSurface.defaultPort` | port fallback |
| `PlatformSurface.composeService(...)` | env vars + health path + internal port already in a platform-neutral shape |
| `storages[]` (`StorageIR`) | managed cloud resources to provision |
| `storage.type` (`StorageKind`) | resource type per provider (see §4) |
| `storage.connection` (`ConnectionSourceIR`) | where the app reads its URL — `secret(...)` maps cleanly to a secrets manager |
| `storage.config[]` (`ConfigEntryIR`) | vendor params (region, bucket, vhost, version…) |
| `dataSources[]` (`DataSourceIR`) | context→storage bindings, schema/tablePrefix/ttl/isolation |
| `migrations` (phase ⑨) | post-provision schema migration step |

The `secret(handle)` connection source is a genuine alignment: it already
expresses "resolve this URL from a secrets manager" — exactly what a Terraform
target wants (AWS Secrets Manager / SSM Parameter Store / GCP Secret Manager
reference), rather than baking a literal credential into the artifact.

## 3. What the IR does *not* model (the real gaps)

For *production* IaC (not just dev parity) these are unmodelled today:

- **Resource sizing** — CPU / memory / disk per deployable; instance class /
  storage size per database. No fields exist.
- **Scaling** — replica count, autoscaling targets, min/max. None.
- **Region / availability** — only expressible as a free-form `config`
  entry on a storage; nothing structured at the system level.
- **Provider selection** — no notion of "AWS vs GCP vs k8s". This is a
  generator/CLI-level choice, or a new DSL surface.
- **Ingress / TLS / DNS** — `deployable-networking.md` (proposal, unadopted)
  designs port/URL identity and `serves … at <path>`, which is the natural
  precursor; public hostnames / certs are beyond even that.
- **Backend-to-backend service discovery** — explicitly out of scope of the
  networking proposal (§8 there), but its forward-compat note already
  reserves `http://${peerSlug}:${peerPort}${peerServePath}`.

None of these block a *first* IaC target — they bound its **fidelity**. A v0
can ship sensible defaults (e.g. one Fargate task, `db.t4g.micro`, one AZ) and
expose the rest as generated Terraform `variables` the operator overrides.

## 4. StorageKind → cloud resource mapping

The opinionated payoff. One row per `StorageKind`, per candidate target:

| `StorageKind` | AWS | GCP | Kubernetes / Helm |
|---|---|---|---|
| `postgres` | RDS / Aurora Postgres | Cloud SQL (PG) | Bitnami `postgresql` chart |
| `mysql` | RDS MySQL | Cloud SQL (MySQL) | Bitnami `mysql` |
| `redis` | ElastiCache Redis | Memorystore | Bitnami `redis` |
| `awsS3` | S3 bucket | GCS bucket | MinIO chart |
| `kafka` | MSK | (Confluent / Pub/Sub) | Strimzi / Bitnami `kafka` |
| `rabbitmq` | Amazon MQ | (self-managed) | Bitnami `rabbitmq` |
| `elastic` / `meilisearch` | OpenSearch / EC2 | self-managed | chart |
| `clickhouse` | EC2 / Cloud | self-managed | Altinity operator |
| `bigquery` | (n/a) | BigQuery dataset | (n/a) |
| `restApi` | — (external) | — | — |
| `sqlite` / `inMemory` | — (in-proc, no resource) | — | — |

Deployables map to the compute primitive of the target: **ECS Fargate
service** (AWS) / **Cloud Run service** (GCP) / **Deployment + Service +
Ingress** (k8s), parameterised by `port`, the `composeService` env array, and
the health path.

## 5. Two implementation shapes

### Option A — a system-level artifact emitter (recommended for v0)

Add `src/system/terraform.ts` exporting a pure
`renderTerraform(sys: EnrichedSystemIR): Map<string, string>` and call it from
`emitSystem` alongside `renderDockerCompose`, writing into a `terraform/`
subtree (or `.loom/iac/` if we treat it as a derived artifact rather than a
first-class deliverable). Properties:

- **No registry change, no new `Platform`.** It is orthogonal to the
  application-code platforms — it *reads* their `composeService` output and
  `needsDb`/`defaultPort` flags.
- **Pure + deterministic + diffable** — same philosophy as `wire-spec.json`
  and the mermaid views. Fits the `.loom/` artifact discipline.
- **Honours the architectural invariant** (no target-backend IR; reads
  `SystemIR` directly).
- Smallest possible blast radius; ships one opinionated provider first.

Generated layout (AWS sketch):

```
terraform/
  main.tf            # provider + backend("s3") config
  variables.tf       # region, image tags, db sizing (defaults overridable)
  network.tf         # vpc / subnets / security groups
  data.tf            # RDS / ElastiCache / S3 / MSK from sys.storages
  services.tf        # one ECS service per deployable (port, env, health)
  secrets.tf         # SSM/Secrets Manager entries for secret(...) sources
  outputs.tf         # service URLs, db endpoints
```

### Option B — generalise the compose layer into a `DeployTarget` contract

Promote the existing per-deployable `ComposeServiceShape` into a neutral
**`DeployTarget`** seam (mirroring how `WalkerTarget` abstracts the React vs
HEEx seams). `docker-compose` becomes one `DeployTarget`; `terraform-aws`,
`terraform-gcp`, `helm` become siblings. Each consumes the same neutral
per-deployable descriptor (`env`, `internalPort`, `healthPath`, `dependsOnDb`,
plus a new sizing/scaling block) + `sys.storages`.

This is the cleaner long-term factoring **once there are ≥2 cloud targets**,
but it is premature for one. Recommendation: build Option A first; the moment a
second cloud target appears, refactor the shared per-deployable descriptor out
of `renderDockerCompose` / `renderTerraform` into `DeployTarget` — the
`ComposeServiceShape` is already 80 % of that descriptor.

## 6. DSL surface (only if/when fidelity demands it)

v0 needs **no grammar change** — defaults + generated `variables.tf` cover
sizing/region. When the gaps in §3 start to bite, the minimal additions are:

- per-deployable `resources { cpu:, memory:, replicas: }`,
- a system-level `deploy { provider: aws, region: "…", … }` block (provider +
  region + state backend), and
- reuse the existing `storage.config { … }` map for vendor params (already
  validated per-`StorageKind` against the source-type registry — see
  `resource-model-and-source-types.md`).

Adding any of these follows the standard "adding a language feature" recipe in
`docs/technical.md` (grammar → scope/validate → IR node → lower → consume).

## 7. Recommendation & phasing

1. **Phase 0 (prereq, independently valuable):** make `composeService`
   actually consume `StorageIR.connection` / `dataSources` instead of the
   hard-coded `db:5432/${slug}` URL. This unblocks *both* richer compose and
   any IaC target, and is the smallest honest step. (Today the storage IR is
   declared but largely inert in composition.)
2. **Phase 1:** `src/system/terraform.ts` — Option A, one provider
   (AWS ECS+RDS recommended; it is the most fully-typed mapping above), driven
   by sensible defaults and generated variables. Gate behind a CLI flag /
   `--target terraform` on `generate system`, emit under `terraform/`. Add a
   `docs/iac.md` and one snapshot test asserting deterministic output.
3. **Phase 2:** second provider (GCP Cloud Run or k8s/Helm). At this point
   refactor the shared per-deployable descriptor into a `DeployTarget` seam
   (Option B) under the byte-identical-output discipline.
4. **Phase 3:** DSL fidelity additions from §6 (resources/scaling/region),
   each behind the standard feature recipe and a validator.

This keeps every architectural invariant intact: IaC is a pure
`SystemIR → files` projection living beside docker-compose, it reads the IR
directly rather than introducing a target-specific IR, and it stays
diffable/deterministic like the rest of the `.loom/` bundle.

## Related proposals

- `deployable-networking.md` — port/URL identity; the precursor for ingress
  routing and backend-to-backend discovery.
- `resource-model-and-source-types.md`, `storage-and-platform-config*.md` —
  the `storage` / `dataSource` / `config` model an IaC target consumes.
- `per-package-output-tree.md` — partial-stack output; an IaC-only emission is
  conceptually a sibling "just the infra" subset.
