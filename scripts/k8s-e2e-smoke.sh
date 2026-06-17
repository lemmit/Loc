#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kubernetes cluster smoke for `ddd generate system --k8s` (docs/kubernetes.md).
#
# The heavier e2e tier above the per-PR `helm lint` + `kubeconform` gate:
# actually INSTALL the emitted Helm chart into a throwaway kind cluster and
# prove the workloads boot, the DB Secret wires up, and the backend reaches
# its database (`/ready` → 200).
#
# Scope (first cut, kept fast): one example with a hono backend + a react
# frontend (examples × backends is deliberately NOT a matrix here — that's
# what makes this nightly/label-gated rather than per-PR).  Postgres is a
# throwaway in-cluster Deployment because the chart targets an external DB.
#
# Assumes a kind cluster already exists and kubectl/helm/docker are on PATH
# (the k8s-e2e.yml workflow provisions kind via helm/kind-action).  Run
# locally with: `kind create cluster && npm run test:k8s-e2e`.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DDD="${REPO_ROOT}/web/src/examples/inheritance-system.ddd"
OUT="$(mktemp -d -t loom-k8s-e2e-XXXXXX)"
RELEASE="rel"
FULLNAME="rel-inheritance-system"          # <release>-<chart>
TAG="e2e"
NS="loom-k8s-e2e"
trap 'kubectl delete ns "$NS" --ignore-not-found --wait=false >/dev/null 2>&1 || true; rm -rf "$OUT"' EXIT

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

step "Generate the system with --k8s → $OUT"
node "${REPO_ROOT}/bin/cli.js" generate system "$DDD" -o "$OUT" --k8s

step "Build + kind-load the deployable images"
# Image names match kName(deployable): api, web-app.  Tag must equal the
# chart's global.image.tag (we --set it below).
docker build -t "api:${TAG}" "${OUT}/api"
docker build -t "web-app:${TAG}" "${OUT}/web_app"
kind load docker-image "api:${TAG}" "web-app:${TAG}"

step "Create namespace $NS"
kubectl create namespace "$NS"

step "Stand up a throwaway postgres (the chart targets an external DB)"
# POSTGRES_DB=api creates the one database the hono backend connects to
# (serviceSlug of the `api` deployable).
kubectl -n "$NS" apply -f - <<'YAML'
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
            - { name: POSTGRES_DB, value: api }
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

step "helm install the emitted chart"
helm install "$RELEASE" "${OUT}/helm" \
  --namespace "$NS" \
  --set global.image.tag="${TAG}" \
  --set global.image.pullPolicy=IfNotPresent \
  --set api.database.url="postgres://postgres:postgres@pg:5432/api" \
  --wait --timeout 300s

step "Wait for every workload to become available"
kubectl -n "$NS" rollout status "deploy/${FULLNAME}-api" --timeout=300s
kubectl -n "$NS" rollout status "deploy/${FULLNAME}-web-app" --timeout=300s

step "Smoke the backend through its ClusterIP Service"
# /health = cheap liveness (no DB); /ready = DB-aware (proves the Secret
# wiring + postgres reachability — the whole point of the smoke).  helm
# --wait already gated on the readiness probe (/ready), so this is an
# explicit, logged re-assertion.  We check the pod's terminal phase rather
# than `kubectl run`'s exit code, which doesn't reliably mirror the
# container's.
SMOKE='set -e
for path in /health /ready; do
  echo "GET ${API}:3000${path}"
  curl -fsS -m 10 "${API}:3000${path}"
  echo
done'
kubectl -n "$NS" run smoke --restart=Never \
  --image=curlimages/curl:8.10.1 \
  --env="API=http://${FULLNAME}-api" \
  --command -- sh -c "$SMOKE"
if ! kubectl -n "$NS" wait --for=jsonpath='{.status.phase}'=Succeeded pod/smoke --timeout=90s; then
  echo "SMOKE FAILED — pod did not succeed:"
  kubectl -n "$NS" logs smoke || true
  kubectl -n "$NS" describe pod smoke || true
  exit 1
fi
kubectl -n "$NS" logs smoke
kubectl -n "$NS" delete pod smoke --ignore-not-found

step "OK — chart installs, workloads boot, backend reaches its database."
