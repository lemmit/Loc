#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kubernetes cluster smoke for `ddd generate system --k8s` (docs/kubernetes.md).
#
# The heavier e2e tier above the per-PR `helm lint` + `kubeconform` gate:
# actually INSTALL the emitted Helm chart into a throwaway kind cluster and
# prove ONE backend boots, the DB Secret wires up, the backend reaches its
# database (`/ready` → 200), AND real domain round-trips end to end — a read
# (findAll GET → migrated table → wire shape → 200) and a write (POST a
# fixture body → invariants → INSERT → read it back through findAll).
#
# Parametrized so a CI matrix can fan it across backends.  Each run smokes
# ONE backend deployable; the chart's per-deployable `enabled` toggle lets us
# install just that workload (every other backend/frontend `--set ...
# enabled=false`), so a matrix cell builds a single image:
#
#   SMOKE_DDD      .ddd to generate            (default: inheritance-system)
#   SMOKE_BACKEND  the backend workload name   (default: api)  e.g. hono-api
#   SMOKE_FIXTURE  write round-trip recipe     (default: inheritance fixture)
#
# Everything else (chart name, values key, container/service ports, db name,
# image, build dir, the workloads to disable) is DERIVED from the generated
# chart + the `<workload>` → image / `<workload with _>` → dir|db convention,
# so adding a backend to the matrix needs only the three vars above.  Postgres
# is a throwaway in-cluster Deployment because the chart targets an external DB.
#
# Assumes a kind cluster already exists and kubectl/helm/docker are on PATH
# (the k8s-e2e.yml workflow provisions kind via helm/kind-action).  Run
# locally with: `kind create cluster && npm run test:k8s-e2e`.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDD="${SMOKE_DDD:-${REPO_ROOT}/web/src/examples/inheritance-system.ddd}"
TARGET="${SMOKE_BACKEND:-api}"
FIXTURE="${SMOKE_FIXTURE:-${REPO_ROOT}/scripts/k8s-e2e/inheritance-system.smoke.json}"
OUT="$(mktemp -d -t loom-k8s-e2e-XXXXXX)"
RELEASE="rel"
TAG="e2e"
NS="loom-k8s-e2e"
trap 'kubectl delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true; rm -rf "$OUT"' EXIT

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Generate $(basename "$DDD") with --k8s → $OUT"
node "${REPO_ROOT}/bin/cli.js" generate system "$DDD" -o "$OUT" --k8s

# ---- Derive everything for SMOKE_BACKEND from the generated chart ----------
DEP="${OUT}/helm/templates/${TARGET}-deployment.yaml"
SVC="${OUT}/helm/templates/${TARGET}-service.yaml"
[ -f "$DEP" ] || { echo "no deployment template for backend '${TARGET}' — is SMOKE_BACKEND a backend workload name?"; echo "available:"; ls "${OUT}/helm/templates/" | sed -n 's/-deployment\.yaml$//p'; exit 1; }
CHART="$(awk '/^name:/{print $2; exit}' "${OUT}/helm/Chart.yaml")"
FULLNAME="${RELEASE}-${CHART}"                                   # <release>-<chart>
VK="$(grep -oE '\.Values\.[A-Za-z0-9]+\.replicas' "$DEP" | head -1 | sed -E 's/\.Values\.([A-Za-z0-9]+)\.replicas/\1/')"
SPORT="$(grep -oE 'port: [0-9]+' "$SVC" | grep -oE '[0-9]+' | head -1)"
DB="${TARGET//-/_}"          # workload `hono-api` → db `hono_api` (serviceSlug)
DIR="${TARGET//-/_}"         # build context dir mirrors the db/slug
IMAGE="${TARGET}"            # image ref matches the workload name
echo "backend=${TARGET} valuesKey=${VK} servicePort=${SPORT} db=${DB} chart=${CHART}"

step "Build + kind-load the ${IMAGE} image"
docker build -t "${IMAGE}:${TAG}" "${OUT}/${DIR}"
kind load docker-image "${IMAGE}:${TAG}"

step "Create namespace $NS"
kubectl create namespace "$NS"

step "Stand up a throwaway postgres (Service name 'db', database '${DB}')"
# The Service is named `db` to match the host in every backend's chart-default
# database connection string (postgres://…@db, Host=db, jdbc:postgresql://db,
# ecto://…@db).  Each backend's URL FORMAT differs (node-postgres URL / Npgsql
# keywords / asyncpg / JDBC / ecto), so we DON'T override it — we just point the
# shared `db` host at this pod, with the matching user/password and the one
# database the backend expects (POSTGRES_DB=${DB}, the serviceSlug).
kubectl -n "$NS" apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: db
  labels: { app: db }
spec:
  replicas: 1
  selector: { matchLabels: { app: db } }
  template:
    metadata: { labels: { app: db } }
    spec:
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - { name: POSTGRES_USER, value: postgres }
            - { name: POSTGRES_PASSWORD, value: postgres }
            - { name: POSTGRES_DB, value: ${DB} }
          ports: [{ containerPort: 5432 }]
          readinessProbe:
            exec: { command: ["pg_isready", "-U", "postgres"] }
            initialDelaySeconds: 3
            periodSeconds: 3
---
apiVersion: v1
kind: Service
metadata:
  name: db
spec:
  selector: { app: db }
  ports: [{ port: 5432, targetPort: 5432 }]
YAML
kubectl -n "$NS" rollout status deploy/db --timeout=120s

step "helm install the chart with only '${TARGET}' enabled"
# Disable every other workload (backends + frontends) so this cell installs a
# single image; the per-deployable `enabled` toggle gates each template.
DISABLE=()
while read -r k; do
  [ "$k" = "$VK" ] && continue
  DISABLE+=( --set "${k}.enabled=false" )
done < <(grep -E '^[A-Za-z]' "${OUT}/helm/values.yaml" | grep -vE '^(global|ingress):' | sed 's/:.*//')
# NB: we do NOT --set database.url — the chart default (host `db`, the right
# scheme for this backend, db `${DB}`) is exactly what the throwaway pg serves.
helm install "$RELEASE" "${OUT}/helm" \
  --namespace "$NS" \
  --set global.image.tag="${TAG}" \
  --set global.image.pullPolicy=IfNotPresent \
  "${DISABLE[@]}" \
  --wait --timeout 300s

step "Wait for the backend workload to become available"
kubectl -n "$NS" rollout status "deploy/${FULLNAME}-${TARGET}" --timeout=300s

step "Smoke the backend through its ClusterIP Service"
# /health = cheap liveness (no DB); /ready = DB-aware (proves the Secret
# wiring + postgres reachability).  helm --wait already gated on the readiness
# probe (/ready), so this is an explicit, logged re-assertion through the
# Service.  We check the pod's terminal phase rather than `kubectl run`'s exit
# code, which doesn't reliably mirror the container's.
SMOKE='set -e
for path in /health /ready; do
  echo "GET ${API}${path}"
  curl -fsS -m 10 "${API}${path}"
  echo
done'
kubectl -n "$NS" run smoke --restart=Never \
  --image=curlimages/curl:8.10.1 \
  --env="API=http://${FULLNAME}-${TARGET}:${SPORT}" \
  --command -- sh -c "$SMOKE"
if ! kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/smoke --timeout=90s; then
  echo "SMOKE FAILED — pod did not succeed:"
  kubectl -n "$NS" logs smoke || true
  kubectl -n "$NS" describe pod smoke || true
  exit 1
fi
kubectl -n "$NS" logs smoke
kubectl -n "$NS" delete pod smoke --ignore-not-found

step "Real read + write round-trip through the backend"
# /ready only proves a DB *connection*.  This proves the whole data path:
#   read  — GET the fixture's list endpoint: migrations applied at boot → the
#           repository's findAll SELECT hits a real, migrated table → the wire
#           shape serializes → 200 (a missing table would 500).
#   write — POST the fixture's create body → the domain validates its
#           invariants → INSERT → the row reads back through findAll.
# Both come from a per-example fixture (scripts/k8s-e2e/<example>.smoke.json):
# the invariants the body must satisfy (e.g. last4.length == 4) live in the
# domain, not the OpenAPI request schema, so a synthesized body would 422 —
# and a fixed list path is uniform across backends (the OpenAPI doc path is
# not).  One fixture is backend-agnostic: Loom's wire shape is identical
# across backends.  Runs in a throwaway node:alpine pod hitting the backend's
# ClusterIP Service (NOT `kubectl exec` into the backend — only the hono image
# is a node container; dotnet/python/java/phoenix have no node).  The fixture
# rides in as a (single-line) env var; `node -` reads the script from stdin,
# wrapped in an async IIFE so it runs as CommonJS (the piped-stdin default).
# Pod phase is the gate (kubectl run's exit code doesn't mirror the container).
FIX="$(node -e 'process.stdout.write(JSON.stringify(require(process.argv[1])))' "$FIXTURE")"
kubectl -n "$NS" run roundtrip -i --restart=Never \
  --image=node:24-alpine \
  --env="API=http://${FULLNAME}-${TARGET}:${SPORT}" \
  --env="SMOKE_FIXTURE=${FIX}" \
  --command -- node - <<'NODE' || true
const BASE = process.env.API;
const fail = (m) => { console.error("ROUND-TRIP FAILED: " + m); process.exit(1); };
const fx = JSON.parse(process.env.SMOKE_FIXTURE ?? "{}");
const idField = fx.idField ?? "id";
const rows = (b) => (Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : []);
// Most backends serve the REST routes at the root; the Elixir foundations
// mount them under `/api`.  Probe both prefixes against the list endpoint and
// use whichever answers 200 — keeps the fixture path backend-agnostic.
const PREFIXES = ["", "/api"];

(async () => {
  let prefix = null;
  let before = null;
  for (const p of PREFIXES) {
    const r = await fetch(`${BASE}${p}${fx.list}`).catch(() => null);
    if (r && r.ok) { prefix = p; before = rows(await r.json()); break; }
  }
  if (prefix === null) fail(`list endpoint not found at ${PREFIXES.map((p) => `${p}${fx.list}`).join(" or ")}`);
  const listUrl = `${BASE}${prefix}${fx.list}`;
  const createUrl = `${BASE}${prefix}${fx.create.path}`;
  // READ: baseline count off the migrated table (holds regardless of seeds).
  console.log(`GET ${prefix}${fx.list} → ${before.length} row(s) — DB read path OK`);

  // WRITE: create, expect 201, then read it back.
  const post = await fetch(createUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fx.create.body),
  });
  if (post.status !== 201 && post.status !== 200) fail(`POST ${prefix}${fx.create.path} → ${post.status} ${await post.text().catch(() => "")}`);
  const created = await post.json().catch(() => fail(`POST ${prefix}${fx.create.path} → ${post.status} but body is not JSON`));
  const id = created?.[idField];
  if (!id) fail(`POST ${prefix}${fx.create.path} → ${post.status} but response has no "${idField}"`);
  console.log(`POST ${prefix}${fx.create.path} → ${post.status}, ${idField}=${id}`);

  const after = rows(await fetch(listUrl).then((r) => (r.ok ? r.json() : fail(`read-back GET ${prefix}${fx.list} → ${r.status}`))));
  if (!after.some((row) => row?.[idField] === id)) fail(`created ${idField}=${id} not found in GET ${prefix}${fx.list} (${after.length} row(s))`);
  if (after.length <= before.length) fail(`row count did not grow (${before.length} → ${after.length})`);
  console.log(`GET ${prefix}${fx.list} → ${after.length} row(s), includes ${id} — write path OK (${before.length} → ${after.length})`);
})().catch((e) => fail(String(e?.stack ?? e)));
NODE
if ! kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/roundtrip --timeout=120s; then
  echo "ROUND-TRIP FAILED — pod did not succeed:"
  kubectl -n "$NS" logs roundtrip || true
  kubectl -n "$NS" describe pod roundtrip || true
  exit 1
fi
RT_LOG="$(kubectl -n "$NS" logs roundtrip 2>/dev/null || true)"
echo "$RT_LOG"
# Guard against a false pass: if the pod won the stdin race and `node -` got
# empty input, it would exit 0 having run nothing.  Require the success marker.
echo "$RT_LOG" | grep -q "write path OK" || {
  echo "ROUND-TRIP FAILED — success marker absent (script did not run to completion)"
  exit 1
}
kubectl -n "$NS" delete pod roundtrip --ignore-not-found

step "OK — '${TARGET}' installs, boots, and real DB read + write round-trip."
