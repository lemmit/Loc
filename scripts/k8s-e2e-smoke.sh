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
CPORT="$(grep -oE 'containerPort: [0-9]+' "$DEP" | grep -oE '[0-9]+' | head -1)"
SPORT="$(grep -oE 'port: [0-9]+' "$SVC" | grep -oE '[0-9]+' | head -1)"
DB="${TARGET//-/_}"          # workload `hono-api` → db `hono_api` (serviceSlug)
DIR="${TARGET//-/_}"         # build context dir mirrors the db/slug
IMAGE="${TARGET}"            # image ref matches the workload name
echo "backend=${TARGET} valuesKey=${VK} containerPort=${CPORT} servicePort=${SPORT} db=${DB} chart=${CHART}"

step "Build + kind-load the ${IMAGE} image"
docker build -t "${IMAGE}:${TAG}" "${OUT}/${DIR}"
kind load docker-image "${IMAGE}:${TAG}"

step "Create namespace $NS"
kubectl create namespace "$NS"

step "Stand up a throwaway postgres with database '${DB}'"
# POSTGRES_DB=${DB} creates the one database this backend connects to.
kubectl -n "$NS" apply -f - <<YAML
apiVersion: apps/v1
kind: Deployment
metadata:
  name: pg
  labels: { app: pg }
spec:
  replicas: 1
  selector: { matchLabels: { app: pg } }
  template:
    metadata: { labels: { app: pg } }
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
  name: pg
spec:
  selector: { app: pg }
  ports: [{ port: 5432, targetPort: 5432 }]
YAML
kubectl -n "$NS" rollout status deploy/pg --timeout=120s

step "helm install the chart with only '${TARGET}' enabled"
# Disable every other workload (backends + frontends) so this cell installs a
# single image; the per-deployable `enabled` toggle gates each template.
DISABLE=()
while read -r k; do
  [ "$k" = "$VK" ] && continue
  DISABLE+=( --set "${k}.enabled=false" )
done < <(grep -E '^[A-Za-z]' "${OUT}/helm/values.yaml" | grep -vE '^(global|ingress):' | sed 's/:.*//')
helm install "$RELEASE" "${OUT}/helm" \
  --namespace "$NS" \
  --set global.image.tag="${TAG}" \
  --set global.image.pullPolicy=IfNotPresent \
  --set "${VK}.database.url=postgres://postgres:postgres@pg:5432/${DB}" \
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
# across backends.  Runs inside the backend pod via the container's own node
# (global fetch) at the derived container port, so it needs no extra image and
# no port-forward.  The fixture rides in as an env var (kubectl exec passes
# argv verbatim; the value's embedded quotes are inside the outer "" so the
# shell keeps them).  Wrapped in an async IIFE so it runs whether node treats
# piped stdin as CommonJS (the default — no top-level await) or ESM.
FIX="$(cat "$FIXTURE")"
kubectl -n "$NS" exec -i "deploy/${FULLNAME}-${TARGET}" -- env SMOKE_FIXTURE="$FIX" BASE_PORT="$CPORT" node - <<'NODE'
const BASE = `http://localhost:${process.env.BASE_PORT}`;
const fail = (m) => { console.error("ROUND-TRIP FAILED: " + m); process.exit(1); };
const fx = JSON.parse(process.env.SMOKE_FIXTURE ?? "{}");
const idField = fx.idField ?? "id";
const rows = (b) => (Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : []);
const getList = async (label) =>
  rows(await fetch(`${BASE}${fx.list}`).then((r) => (r.ok ? r.json() : fail(`${label} GET ${fx.list} → ${r.status}`))));

(async () => {
  // READ: baseline count off the migrated table (holds regardless of seeds).
  const before = await getList("read");
  console.log(`GET ${fx.list} → ${before.length} row(s) — DB read path OK`);

  // WRITE: create, expect 201, then read it back.
  const post = await fetch(`${BASE}${fx.create.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fx.create.body),
  });
  if (post.status !== 201 && post.status !== 200) fail(`POST ${fx.create.path} → ${post.status} ${await post.text().catch(() => "")}`);
  const created = await post.json().catch(() => fail(`POST ${fx.create.path} → ${post.status} but body is not JSON`));
  const id = created?.[idField];
  if (!id) fail(`POST ${fx.create.path} → ${post.status} but response has no "${idField}"`);
  console.log(`POST ${fx.create.path} → ${post.status}, ${idField}=${id}`);

  const after = await getList("read-back");
  if (!after.some((row) => row?.[idField] === id)) fail(`created ${idField}=${id} not found in GET ${fx.list} (${after.length} row(s))`);
  if (after.length <= before.length) fail(`row count did not grow (${before.length} → ${after.length})`);
  console.log(`GET ${fx.list} → ${after.length} row(s), includes ${id} — write path OK (${before.length} → ${after.length})`);
})().catch((e) => fail(String(e?.stack ?? e)));
NODE

step "OK — '${TARGET}' installs, boots, and real DB read + write round-trip."
