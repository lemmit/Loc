import {
  brokerUrl,
  devPassword,
  kafkaJaasConfig,
  renderRabbitDefinitions,
} from "../generator/_channels/auth.js";
import {
  type BrokerTransport,
  brokerChannelBindings,
  channelTransportStorageNames,
} from "../generator/_channels/bindings.js";
import type { DeployableIR, SystemIR } from "../ir/types/loom-ir.js";
import { platformFor } from "../platform/registry.js";

// ---------------------------------------------------------------------------
// Kubernetes raw-manifest emitter (D-K8S-FORMAT / D-K8S-SCOPE — see
// docs/kubernetes.md).
//
// `renderKubernetesManifests(sys)` produces plain (non-templated) YAML under
// `k8s/` — the "what the Helm chart renders to with its defaults" fallback
// view.  `src/system/helm.ts` consumes the SAME `WorkloadModel` built here
// (`buildWorkloads`) so the two stay structurally in lock-step; only the
// value-substitution seam differs (raw bakes the defaults in, Helm threads
// them through `values.yaml`).
//
// Emitter-only, by design: nothing in the grammar or IR changes.  Every infra
// knob the DSL doesn't model (replicas / resources / ingress / registry) has a
// home in the chart's `values.yaml`; the raw manifests show the default
// resolution of those knobs.  The DB is assumed external / managed — the
// connection string is surfaced as a `Secret` (placeholder), never an
// in-cluster postgres.  The dev `docker-compose.yml` keeps its in-container
// postgres for the inner loop; this path is the production-leaning sibling.
// ---------------------------------------------------------------------------

/** One classified environment entry destined for a workload. */
export interface WorkloadEnv {
  name: string;
  /** The dev-default value (also the placeholder baked into raw manifests
   *  and the `values.yaml` default). */
  value: string;
}

/** A platform-neutral description of one deployable's k8s workload, derived
 *  from exactly the data the compose path already reads
 *  (`PlatformSurface.composeService` + `DeployableIR`).  Both the Helm and the
 *  raw-manifest renderers consume this. */
export interface WorkloadModel {
  /** Source deployable name (for diagnostics / labels). */
  deployableName: string;
  /** DNS-1123 resource base name (`webApp` → `web-app`). */
  name: string;
  /** Helm `values.yaml` key + `.Values.<key>` accessor (the raw deployable
   *  identifier — already a valid Go-template field name). */
  valuesKey: string;
  /** Container image name (registry-less); the registry + tag are prefixed
   *  from `values.global.image`. */
  image: string;
  /** Service port (the deployable's declared external port). */
  servicePort: number;
  /** Container / target port (the listener the service binds inside). */
  containerPort: number;
  /** Liveness probe path — a cheap check (`/health` on DB-backed backends,
   *  whose `/ready` is reserved for readiness so a DB blip doesn't restart
   *  the pod). */
  livenessPath: string;
  /** Readiness probe path — the DB-aware `/ready` on backends, `/` on
   *  static frontends. */
  readinessPath: string;
  /** Whether this workload connects to the (external) database. */
  dependsOnDb: boolean;
  /** Whether this workload should get an optional `Ingress` (it serves a
   *  browser-facing UI). */
  exposesUi: boolean;
  /** Whether this workload serves Prometheus metrics at `/metrics` (every
   *  backend does; pure static frontends don't) — gates the pod's
   *  prometheus.io scrape annotations. */
  emitsMetrics: boolean;
  /** When this is a frontend SPA that targets a DISTINCT backend deployable,
   *  the backend's service coordinates — so the SPA's `Ingress` can route
   *  `/api` → that backend and `/` → this SPA on one host (same-origin: the
   *  built bundle fetches `/api` relative).  Absent for pure backends and for
   *  fullstack hosts that serve their own `/api` (a single `/` rule covers
   *  those). */
  apiBackend?: { name: string; servicePort: number };
  /** Non-secret env, emitted via a `ConfigMap`. */
  configEnv: WorkloadEnv[];
  /** DB-connection env, sourced from the shared `Secret`.  `secretKey` is
   *  the Secret's data key; `name` is the container env var name.  Wired in
   *  the chart via `.Values.<key>.database.url` (the friendliest single
   *  knob). */
  dbEnv: SecretEnv[];
  /** Other sensitive env (passwords / app secret keys / tokens), also
   *  sourced from the shared `Secret` but wired via the generic
   *  `.Values.<key>.secrets.<NAME>` map.  Keeps secrets out of the
   *  plaintext `ConfigMap`. */
  secretEnv: SecretEnv[];
  /** Broker channel URLs (`LOOM_CHANNEL_<NAME>_URL` — M-T4.4 slice 5b).
   *  Secret-sourced (they embed the §7 credentials); `value` is the raw
   *  view's in-cluster URL (plain service name), `chartFormat` the printf
   *  format the chart's Secret template resolves with the release fullname
   *  (`%s-<broker>`), overridable via `.Values.<key>.channels.<NAME>`. */
  channelEnv: (SecretEnv & { chartFormat: string })[];
}

/** A sensitive env entry sourced from the shared `Secret`. */
export interface SecretEnv {
  /** Container env var name. */
  name: string;
  /** The Secret's data key (deployable-namespaced, DNS-1123). */
  secretKey: string;
  /** Dev-default value, used as the placeholder baked into the raw Secret
   *  and the `values.yaml` default. */
  value: string;
}

/** Convert an identifier (camelCase / snake_case) into a DNS-1123 label:
 *  lowercase, hyphen-separated, no underscores (k8s resource names forbid
 *  them, unlike the compose service slug). */
export function kName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** A connection-string value is DB-derived iff it points at the compose
 *  `db` host.  Every backend's `composeService` env spells this either as
 *  `…@db:5432/…` (hono/python/elixir url form), `…//db:5432/…` (jdbc) or
 *  `Host=db;…` (the .NET connection-string form).  Such entries become a
 *  `Secret` reference; everything else (ports, build-time `VITE_*`, the
 *  Phoenix `SECRET_KEY_BASE` — a deferred concern, see docs/kubernetes.md)
 *  stays plain `ConfigMap` data in v1. */
function isDbConnection(value: string): boolean {
  return value.includes("db:5432") || /Host=db\b/i.test(value);
}

function exposesUi(d: DeployableIR): boolean {
  const platform = platformFor(d.platform);
  // Standalone frontends (react / svelte / vue / static) always serve a
  // browser-facing bundle; a fullstack host (phoenixLiveView, or a dotnet
  // deployable that mounts a `ui:`) does too.  Pure backends stay ClusterIP.
  return platform.isFrontend || (platform.mountsUi && !!d.uiName);
}

/** Build the shared workload model for every deployable in the system. */
export function buildWorkloads(sys: SystemIR): WorkloadModel[] {
  return sys.deployables.map((d) => {
    const platform = platformFor(d.platform);
    const slug = serviceSlug(d.name);
    const shape = platform.composeService({ deployable: d, sys, slug });
    const name = kName(d.name);
    const configEnv: WorkloadEnv[] = [];
    const dbEnv: SecretEnv[] = [];
    const secretEnv: SecretEnv[] = [];
    // Secret classification is BACKEND-DECLARED (shape.secretEnvKeys), not
    // name-guessed — the backend owns which of its env is sensitive.  The DB
    // connection is identified by its value embedding the compose `db` host
    // (a structural match generated by the same backend code, deterministic),
    // which only selects the friendlier `database.url` values knob; getting
    // it "wrong" would still keep the value in the Secret, never leak it.
    // Same-origin ingress split: a frontend SPA fetches `/api` relative, so
    // when it `targets:` a distinct, pure backend we capture that backend's
    // service coordinates for the SPA's Ingress (`/api` → backend, `/` → SPA).
    // A fullstack host (serves its own `/api`) or a target that is itself
    // UI-serving keeps the single `/` catch-all, so it stays undefined.
    let apiBackend: { name: string; servicePort: number } | undefined;
    if (exposesUi(d) && d.targetName) {
      const target = sys.deployables.find((t) => t.name === d.targetName);
      if (target && target.name !== d.name && !exposesUi(target)) {
        apiBackend = { name: kName(target.name), servicePort: target.port };
      }
    }
    // Broker channel URLs (M-T4.4 slice 5b): the same credentialed URLs
    // compose injects, re-hosted at the in-cluster broker Service.
    const channelEnv = brokerChannelBindings(d, sys).map((b) => ({
      name: b.envVar,
      secretKey: `${name}-${kName(b.envVar)}`,
      value: brokerUrl(b, d.name, kName(b.storageName)),
      chartFormat: brokerUrl(b, d.name, `%s-${kName(b.storageName)}`),
    }));
    const secretKeys = new Set(shape.secretEnvKeys ?? []);
    for (const [k, v] of shape.env) {
      if (shape.dependsOnDb && isDbConnection(v)) {
        dbEnv.push({ name: k, secretKey: `${name}-${kName(k)}`, value: v });
      } else if (secretKeys.has(k)) {
        secretEnv.push({ name: k, secretKey: `${name}-${kName(k)}`, value: v });
      } else {
        configEnv.push({ name: k, value: v });
      }
    }
    // k8s prod-hardening: disable the interactive OpenAPI UI by default on
    // backends (Java's Swagger UI / Python's /docs+/redoc).  The machine
    // /openapi.json spec stays available; compose leaves it ON for the inner
    // loop.  Override per deployable via the chart's `env:` overlay.
    if (!platform.isFrontend) {
      configEnv.push({ name: "LOOM_OPENAPI_UI", value: "false" });
    }
    return {
      deployableName: d.name,
      name,
      valuesKey: d.name,
      image: name,
      servicePort: d.port,
      containerPort: shape.internalPort,
      // Uniform probe endpoints across every DB-backed backend: each emits
      // BOTH a cheap `/health` (no DB) and a DB-aware `/ready` (verified for
      // hono / .NET / python / java / phoenix).  Liveness uses /health so a
      // transient DB outage gates traffic (readiness) instead of restarting
      // the pod.  Frontends expose neither — probe their static root.  This
      // is why we don't derive from `healthPath` here: that field reflects
      // each backend's COMPOSE healthcheck choice (phoenix points it at
      // /health), which would otherwise leak a non-DB-aware readiness probe.
      livenessPath: shape.dependsOnDb ? "/health" : shape.healthPath,
      readinessPath: shape.dependsOnDb ? "/ready" : shape.healthPath,
      dependsOnDb: shape.dependsOnDb,
      exposesUi: exposesUi(d),
      // Backends expose Prometheus metrics at /metrics (M-T7.1); pure static
      // frontends do not.  Drives the pod's prometheus.io scrape annotations.
      emitsMetrics: !platform.isFrontend,
      apiBackend,
      configEnv,
      dbEnv,
      secretEnv,
      channelEnv,
    };
  });
}

// ---------------------------------------------------------------------------
// Broker workloads (M-T4.4 slice 5b) — the in-cluster siblings of the compose
// broker sidecars, carrying the same §7 auth provisioning.  Rendered by both
// the raw view here and the chart (enabled-gated per broker: set
// `.Values.brokers.<storage>.enabled=false` and point the deployables'
// `channels:` URLs at a managed broker instead).
// ---------------------------------------------------------------------------

export interface BrokerModel {
  storageName: string;
  /** values.yaml key under `brokers:` — the storage name verbatim (no
   *  hyphens, so no `index` gymnastics in templates). */
  valuesKey: string;
  /** DNS-1123 workload/service name. */
  name: string;
  transport: BrokerTransport;
  image: string;
  port: number;
  /** Container args (valkey's requirepass). */
  args: string[];
  /** Env, with every `%s` in a value standing for the service-name prefix
   *  (chart: the release fullname via printf; raw: dropped).  Only kafka's
   *  advertised listeners use it. */
  env: [string, string][];
  /** Readiness/liveness exec probe command. */
  probe: string[];
  /** ConfigMap-mounted files (rabbit definitions + conf). */
  files: { fileName: string; mountPath: string; content: string }[];
}

export function buildBrokers(sys: SystemIR): BrokerModel[] {
  const out: BrokerModel[] = [];
  for (const storageName of channelTransportStorageNames(sys)) {
    const s = sys.storages.find((st) => st.name === storageName);
    if (!s || (s.type !== "redis" && s.type !== "rabbitmq" && s.type !== "kafka")) continue;
    const name = kName(storageName);
    if (s.type === "redis") {
      const pass = devPassword(storageName);
      out.push({
        storageName,
        valuesKey: storageName,
        name,
        transport: "redis",
        image: "valkey/valkey:8-alpine",
        port: 6379,
        args: ["valkey-server", "--requirepass", pass],
        env: [],
        probe: ["valkey-cli", "-a", pass, "ping"],
        files: [],
      });
    } else if (s.type === "rabbitmq") {
      out.push({
        storageName,
        valuesKey: storageName,
        name,
        transport: "rabbitmq",
        image: "rabbitmq:4-management-alpine",
        port: 5672,
        args: [],
        env: [],
        probe: ["rabbitmq-diagnostics", "-q", "ping"],
        files: [
          {
            fileName: "10-loom.conf",
            mountPath: "/etc/rabbitmq/conf.d/10-loom.conf",
            content: "# Auto-generated.\nload_definitions = /etc/rabbitmq/loom-definitions.json\n",
          },
          {
            fileName: "loom-definitions.json",
            mountPath: "/etc/rabbitmq/loom-definitions.json",
            content: renderRabbitDefinitions(sys, storageName),
          },
        ],
      });
    } else {
      // Same single-node KRaft + SASL/PLAIN CLIENT listener as compose; the
      // advertised host is the broker's own Service (`%s` = name prefix in
      // the chart, empty in the raw view).
      out.push({
        storageName,
        valuesKey: storageName,
        name,
        transport: "kafka",
        image: "apache/kafka:4.1.0",
        port: 9092,
        args: [],
        env: [
          ["KAFKA_NODE_ID", "1"],
          ["KAFKA_PROCESS_ROLES", "broker,controller"],
          ["KAFKA_LISTENERS", "CLIENT://:9092,PLAINTEXT://:9094,CONTROLLER://:9093"],
          ["KAFKA_ADVERTISED_LISTENERS", `CLIENT://%s-${name}:9092,PLAINTEXT://%s-${name}:9094`],
          ["KAFKA_CONTROLLER_LISTENER_NAMES", "CONTROLLER"],
          ["KAFKA_CONTROLLER_QUORUM_VOTERS", "1@localhost:9093"],
          [
            "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP",
            "CONTROLLER:PLAINTEXT,PLAINTEXT:PLAINTEXT,CLIENT:SASL_PLAINTEXT",
          ],
          ["KAFKA_INTER_BROKER_LISTENER_NAME", "PLAINTEXT"],
          ["KAFKA_LISTENER_NAME_CLIENT_SASL_ENABLED_MECHANISMS", "PLAIN"],
          ["KAFKA_LISTENER_NAME_CLIENT_PLAIN_SASL_JAAS_CONFIG", kafkaJaasConfig(sys, storageName)],
          ["KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR", "1"],
          ["KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR", "1"],
          ["KAFKA_TRANSACTION_STATE_LOG_MIN_ISR", "1"],
          ["KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS", "0"],
          ["KAFKA_NUM_PARTITIONS", "3"],
        ],
        probe: [
          "/opt/kafka/bin/kafka-broker-api-versions.sh",
          "--bootstrap-server",
          "localhost:9094",
        ],
        files: [],
      });
    }
  }
  return out;
}

/** Same compose-safe slug as `src/system/index.ts` — kept local so this
 *  emitter doesn't reach into the orchestrator (one-directional layering). */
function serviceSlug(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// ---------------------------------------------------------------------------
// Raw-manifest rendering.  Concrete YAML with the chart's defaults baked in.
// ---------------------------------------------------------------------------

const PART_OF = (sys: SystemIR) => kName(sys.name) || "loom";

function commonLabels(sys: SystemIR, name: string): string[] {
  return [
    `  labels:`,
    `    app.kubernetes.io/name: ${name}`,
    `    app.kubernetes.io/part-of: ${PART_OF(sys)}`,
    `    app.kubernetes.io/managed-by: loom`,
  ];
}

function renderDeployment(sys: SystemIR, w: WorkloadModel): string {
  const lines: string[] = [];
  lines.push("apiVersion: apps/v1");
  lines.push("kind: Deployment");
  lines.push("metadata:");
  lines.push(`  name: ${w.name}`);
  lines.push(...commonLabels(sys, w.name));
  lines.push("spec:");
  lines.push("  replicas: 1");
  lines.push("  selector:");
  lines.push("    matchLabels:");
  lines.push(`      app.kubernetes.io/name: ${w.name}`);
  lines.push("  template:");
  lines.push("    metadata:");
  lines.push("      labels:");
  lines.push(`        app.kubernetes.io/name: ${w.name}`);
  // Prometheus scrape discovery (M-T7.1): the standard prometheus.io pod
  // annotations a Prometheus (agent/Operator with the pod-annotation
  // relabel config) uses to find + scrape this backend's /metrics.  Only
  // backends emit metrics; static frontends get none.
  if (w.emitsMetrics) {
    lines.push("      annotations:");
    lines.push('        prometheus.io/scrape: "true"');
    lines.push(`        prometheus.io/port: "${w.containerPort}"`);
    lines.push("        prometheus.io/path: /metrics");
  }
  lines.push("    spec:");
  lines.push("      containers:");
  lines.push(`        - name: ${w.name}`);
  // Empty registry default ⇒ a local image ref (`<image>:latest`).
  lines.push(`          image: ${w.image}:latest`);
  lines.push(`          imagePullPolicy: IfNotPresent`);
  lines.push("          ports:");
  lines.push(`            - containerPort: ${w.containerPort}`);
  if (w.configEnv.length > 0) {
    lines.push("          envFrom:");
    lines.push("            - configMapRef:");
    lines.push(`                name: ${w.name}-config`);
  }
  const secretRefs = [...w.dbEnv, ...w.secretEnv, ...w.channelEnv];
  if (secretRefs.length > 0) {
    lines.push("          env:");
    for (const e of secretRefs) {
      lines.push(`            - name: ${e.name}`);
      lines.push("              valueFrom:");
      lines.push("                secretKeyRef:");
      lines.push(`                  name: ${PART_OF(sys)}-secrets`);
      lines.push(`                  key: ${e.secretKey}`);
    }
  }
  lines.push("          livenessProbe:");
  lines.push("            httpGet:");
  lines.push(`              path: ${w.livenessPath}`);
  lines.push(`              port: ${w.containerPort}`);
  lines.push("            initialDelaySeconds: 10");
  lines.push("            periodSeconds: 10");
  lines.push("          readinessProbe:");
  lines.push("            httpGet:");
  lines.push(`              path: ${w.readinessPath}`);
  lines.push(`              port: ${w.containerPort}`);
  lines.push("            initialDelaySeconds: 5");
  lines.push("            periodSeconds: 5");
  lines.push("          resources:");
  lines.push("            requests:");
  lines.push(`              cpu: ${w.exposesUi && !w.dependsOnDb ? "50m" : "100m"}`);
  lines.push(`              memory: ${w.exposesUi && !w.dependsOnDb ? "128Mi" : "256Mi"}`);
  lines.push("            limits:");
  lines.push(`              cpu: ${w.exposesUi && !w.dependsOnDb ? "250m" : "500m"}`);
  lines.push(`              memory: ${w.exposesUi && !w.dependsOnDb ? "256Mi" : "512Mi"}`);
  return lines.join("\n") + "\n";
}

function renderService(sys: SystemIR, w: WorkloadModel): string {
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: Service");
  lines.push("metadata:");
  lines.push(`  name: ${w.name}`);
  lines.push(...commonLabels(sys, w.name));
  lines.push("spec:");
  lines.push("  type: ClusterIP");
  lines.push("  selector:");
  lines.push(`    app.kubernetes.io/name: ${w.name}`);
  lines.push("  ports:");
  lines.push(`    - port: ${w.servicePort}`);
  lines.push(`      targetPort: ${w.containerPort}`);
  lines.push("      protocol: TCP");
  return lines.join("\n") + "\n";
}

function renderConfigMap(sys: SystemIR, w: WorkloadModel): string {
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: ConfigMap");
  lines.push("metadata:");
  lines.push(`  name: ${w.name}-config`);
  lines.push(...commonLabels(sys, w.name));
  lines.push("data:");
  for (const e of w.configEnv) lines.push(`  ${e.name}: ${JSON.stringify(e.value)}`);
  return lines.join("\n") + "\n";
}

function renderSecret(sys: SystemIR, workloads: WorkloadModel[]): string {
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: Secret");
  lines.push("metadata:");
  lines.push(`  name: ${PART_OF(sys)}-secrets`);
  lines.push(`  labels:`);
  lines.push(`    app.kubernetes.io/part-of: ${PART_OF(sys)}`);
  lines.push(`    app.kubernetes.io/managed-by: loom`);
  lines.push("type: Opaque");
  lines.push("stringData:");
  // Placeholder values — REPLACE with your managed-DB URLs / real secrets.
  // The dev-compose values are kept as recognisable defaults.
  for (const w of workloads) {
    for (const e of [...w.dbEnv, ...w.secretEnv, ...w.channelEnv]) {
      lines.push(`  ${e.secretKey}: ${JSON.stringify(e.value)}`);
    }
  }
  return lines.join("\n") + "\n";
}

/** Raw broker workload — Deployment + Service (+ file ConfigMap), the
 *  chart-defaults view of the enabled-gated broker subchart (5b). */
function renderBroker(sys: SystemIR, b: BrokerModel): string {
  const lines: string[] = [];
  if (b.files.length > 0) {
    lines.push("apiVersion: v1");
    lines.push("kind: ConfigMap");
    lines.push("metadata:");
    lines.push(`  name: ${b.name}-files`);
    lines.push(...commonLabels(sys, b.name));
    lines.push("data:");
    for (const f of b.files) {
      lines.push(`  ${f.fileName}: |`);
      for (const l of f.content.replace(/\n$/, "").split("\n")) lines.push(`    ${l}`);
    }
    lines.push("---");
  }
  lines.push("apiVersion: apps/v1");
  lines.push("kind: Deployment");
  lines.push("metadata:");
  lines.push(`  name: ${b.name}`);
  lines.push(...commonLabels(sys, b.name));
  lines.push("spec:");
  lines.push("  replicas: 1");
  lines.push("  selector:");
  lines.push("    matchLabels:");
  lines.push(`      app.kubernetes.io/name: ${b.name}`);
  lines.push("  template:");
  lines.push("    metadata:");
  lines.push("      labels:");
  lines.push(`        app.kubernetes.io/name: ${b.name}`);
  lines.push("    spec:");
  lines.push("      containers:");
  lines.push(`        - name: ${b.name}`);
  lines.push(`          image: ${b.image}`);
  if (b.args.length > 0) {
    lines.push(`          args: [${b.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  }
  lines.push("          ports:");
  lines.push(`            - containerPort: ${b.port}`);
  if (b.env.length > 0) {
    lines.push("          env:");
    for (const [k, v] of b.env) {
      lines.push(`            - name: ${k}`);
      // Raw view: the service is plainly named, so the fullname prefix
      // slot resolves to nothing.
      lines.push(`              value: ${JSON.stringify(v.replaceAll("%s-", ""))}`);
    }
  }
  if (b.files.length > 0) {
    lines.push("          volumeMounts:");
    for (const f of b.files) {
      lines.push(`            - name: files`);
      lines.push(`              mountPath: ${f.mountPath}`);
      lines.push(`              subPath: ${f.fileName}`);
    }
  }
  lines.push("          readinessProbe:");
  lines.push("            exec:");
  lines.push(`              command: [${b.probe.map((c) => JSON.stringify(c)).join(", ")}]`);
  lines.push("            initialDelaySeconds: 5");
  lines.push("            periodSeconds: 5");
  if (b.files.length > 0) {
    lines.push("      volumes:");
    lines.push("        - name: files");
    lines.push("          configMap:");
    lines.push(`            name: ${b.name}-files`);
  }
  lines.push("---");
  lines.push("apiVersion: v1");
  lines.push("kind: Service");
  lines.push("metadata:");
  lines.push(`  name: ${b.name}`);
  lines.push(...commonLabels(sys, b.name));
  lines.push("spec:");
  lines.push("  type: ClusterIP");
  lines.push("  selector:");
  lines.push(`    app.kubernetes.io/name: ${b.name}`);
  lines.push("  ports:");
  lines.push(`    - port: ${b.port}`);
  lines.push(`      targetPort: ${b.port}`);
  return lines.join("\n") + "\n";
}

/** Raw Kubernetes manifests under `k8s/` — the default render of the Helm
 *  chart.  Ingress is omitted (the chart ships it disabled by default). */
export function renderKubernetesManifests(sys: SystemIR): Map<string, string> {
  const out = new Map<string, string>();
  const workloads = buildWorkloads(sys);
  for (const w of workloads) {
    out.set(`k8s/${w.name}-deployment.yaml`, renderDeployment(sys, w));
    out.set(`k8s/${w.name}-service.yaml`, renderService(sys, w));
    if (w.configEnv.length > 0) out.set(`k8s/${w.name}-config.yaml`, renderConfigMap(sys, w));
  }
  if (
    workloads.some((w) => w.dbEnv.length > 0 || w.secretEnv.length > 0 || w.channelEnv.length > 0)
  ) {
    out.set("k8s/secret.yaml", renderSecret(sys, workloads));
  }
  for (const b of buildBrokers(sys)) {
    out.set(`k8s/${b.name}-broker.yaml`, renderBroker(sys, b));
  }
  return out;
}
