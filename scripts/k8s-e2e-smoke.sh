#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Kubernetes cluster smoke for `ddd generate system --k8s` (docs/kubernetes.md).
#
# The heavier e2e tier above the per-PR `helm lint` + `kubeconform` gate:
# actually INSTALL the emitted Helm chart into a throwaway kind cluster and
# prove the workloads boot, the DB Secret wires up, the backend reaches its
# database (`/ready` → 200), AND real domain round-trips end to end: a read
# (auto-findAll GET → migrated table → wire shape → 200) and a write (POST a
# fixture body → invariants → INSERT → read it back through findAll).
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
FIXTURE="${REPO_ROOT}/scripts/k8s-e2e/inheritance-system.smoke.json"
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

step "Real round-trip: discover a collection endpoint and read through it"
# /ready only proves a DB *connection*.  This proves the whole data path:
# migrations applied at boot (await migrate(db) before serving) → the
# repository's findAll SELECT hits a real, migrated table → the wire shape
# serializes → HTTP routing is wired.  A missing table would 500 here, so
# the 200 has teeth.  We discover the endpoint from /openapi.json (every
# aggregate gets an auto-findAll GET) so the smoke stays example-agnostic —
# no hardcoded domain path or request body.  Runs inside the api pod via
# the container's own node (global fetch), so it needs no extra image and
# no port-forward.  A write round-trip is deliberately out of scope: a
# valid POST body is domain-specific and would couple this to the example.
# Wrapped in an async IIFE so it runs whether node treats piped stdin as
# CommonJS (the default — no top-level await) or ESM.
kubectl -n "$NS" exec -i "deploy/${FULLNAME}-api" -- node - <<'NODE'
const BASE = "http://localhost:3000";
const SKIP = new Set(["/", "/health", "/ready", "/openapi.json", "/swagger", "/me", "/events"]);
const fail = (m) => { console.error("ROUND-TRIP FAILED: " + m); process.exit(1); };

(async () => {
  const doc = await fetch(`${BASE}/openapi.json`).then((r) => r.ok ? r.json() : fail(`/openapi.json → ${r.status}`));
  // Collection GETs are the auto-findAll list routes: a GET with no `{param}`
  // path segment, excluding the infra/auth/stream endpoints above.  Prefer
  // single-segment roots (the bare `/<plural>` findAll) over deeper paths
  // like `/<plural>/by_network`, which are query routes that may *require*
  // params we don't know — those sort last and act only as a fallback.
  const candidates = Object.entries(doc.paths ?? {})
    .filter(([p, ops]) => ops?.get && !p.includes("{") && !SKIP.has(p))
    .map(([p]) => p)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.length - b.length);
  if (candidates.length === 0) fail("no collection GET route found in /openapi.json");

  // One real 200 + JSON proves the data path (migrated table → repository
  // SELECT → wire shape).  Tolerate a candidate that needs unknown query
  // params (e.g. a 400 from a `by_*` route); only fail if NONE read back.
  const tried = [];
  for (const p of candidates) {
    try {
      const res = await fetch(`${BASE}${p}`);
      if (!res.ok) { tried.push(`${p} → ${res.status}`); continue; }
      const body = await res.json();
      // findAll returns a bare array; paged/enveloped views return an object.
      const n = Array.isArray(body) ? body.length : Array.isArray(body?.items) ? body.items.length : "n/a";
      console.log(`GET ${p} → 200, ${n} row(s) — DB read path OK`);
      process.exit(0);
    } catch (e) {
      tried.push(`${p} → ${e?.message ?? e}`);
    }
  }
  fail(`no collection GET returned 200 + JSON; tried: ${tried.join(", ")}`);
})().catch((e) => fail(String(e?.stack ?? e)));
NODE

step "Real write round-trip: POST a domain object, then read it back"
# The read above proves the SELECT path; this proves the MUTATION path:
# POST a create body → the domain validates its invariants → INSERT into the
# migrated table → the row is persisted and reads back through findAll.  The
# body comes from a per-example fixture (scripts/k8s-e2e/<example>.smoke.json)
# because the invariants it must satisfy (e.g. last4.length == 4) live in the
# domain, not the OpenAPI request schema — a synthesized body would 422.  One
# fixture is backend-agnostic: Loom's wire shape is identical across backends.
# The fixture JSON rides in as an env var (kubectl exec passes argv verbatim;
# the value's embedded quotes are inside the outer "" so the shell keeps them).
FIX="$(cat "$FIXTURE")"
kubectl -n "$NS" exec -i "deploy/${FULLNAME}-api" -- env SMOKE_FIXTURE="$FIX" node - <<'NODE'
const BASE = "http://localhost:3000";
const fail = (m) => { console.error("WRITE ROUND-TRIP FAILED: " + m); process.exit(1); };
const fx = JSON.parse(process.env.SMOKE_FIXTURE ?? "{}");
const idField = fx.idField ?? "id";
const rows = (b) => (Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : []);

(async () => {
  // Baseline count, so the assertion holds no matter what seed data exists.
  const before = rows(await fetch(`${BASE}${fx.list}`).then((r) => r.ok ? r.json() : fail(`GET ${fx.list} → ${r.status}`)));

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

  // Read it back: the new row must be present and the count must have grown.
  const after = rows(await fetch(`${BASE}${fx.list}`).then((r) => r.ok ? r.json() : fail(`GET ${fx.list} → ${r.status}`)));
  if (!after.some((row) => row?.[idField] === id)) fail(`created ${idField}=${id} not found in GET ${fx.list} (${after.length} row(s))`);
  if (after.length <= before.length) fail(`row count did not grow (${before.length} → ${after.length})`);
  console.log(`GET ${fx.list} → ${after.length} row(s), includes ${id} — write path OK (${before.length} → ${after.length})`);
})().catch((e) => fail(String(e?.stack ?? e)));
NODE

step "OK — chart installs, workloads boot, and real DB read + write round-trip."
