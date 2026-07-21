import type { SystemIR } from "../ir/types/loom-ir.js";
import { API_BASE_PATH } from "../util/api-base.js";
import {
  type BrokerModel,
  buildBrokers,
  buildWorkloads,
  kName,
  type WorkloadModel,
} from "./kubernetes.js";

// ---------------------------------------------------------------------------
// Helm chart emitter (D-K8S-FORMAT — see docs/kubernetes.md).
//
// `renderHelmChart(sys)` produces a chart under `helm/`, the PRIMARY
// deliverable of the k8s path; `src/system/kubernetes.ts` renders the same
// `WorkloadModel` to raw manifests as the fallback view.  The chart's
// `values.yaml` is the tuning seam that keeps v1 emitter-only: every infra
// knob the DSL doesn't model (replicas / resources / ingress host / image
// registry / DB url) lives there, overridden at install with
// `--set` / `-f values.prod.yaml`.
//
// Layout (proposal §4.1):
//
//   helm/
//     Chart.yaml
//     values.yaml
//     templates/
//       _helpers.tpl
//       <name>-deployment.yaml   (one per deployable)
//       <name>-service.yaml      (one per deployable, ClusterIP)
//       <name>-ingress.yaml      (UI-serving deployables, gated on values)
//       <name>-config.yaml       (non-secret env ConfigMap)
//       db-secret.yaml           (external DB connection Secret)
//     NOTES.txt
// ---------------------------------------------------------------------------

const FULLNAME = '{{ include "loom.fullname" . }}';

function chartName(sys: SystemIR): string {
  return kName(sys.name) || "loom";
}

function renderChartYaml(sys: SystemIR): string {
  return [
    "apiVersion: v2",
    `name: ${chartName(sys)}`,
    `description: Helm chart for the ${sys.name} Loom system`,
    "type: application",
    "version: 0.1.0",
    'appVersion: "0.1.0"',
    "",
  ].join("\n");
}

function renderHelpers(sys: SystemIR): string {
  const name = chartName(sys);
  // Name helpers + a shared label block.  `loom.fullname` is
  // `<release>-<chart>`, truncated to the 63-char DNS limit.
  return [
    '{{- define "loom.name" -}}',
    `${name}`,
    "{{- end -}}",
    "",
    '{{- define "loom.fullname" -}}',
    '{{- printf "%s-%s" .Release.Name (include "loom.name" .) | trunc 63 | trimSuffix "-" -}}',
    "{{- end -}}",
    "",
    '{{- define "loom.labels" -}}',
    'app.kubernetes.io/part-of: {{ include "loom.name" . }}',
    "app.kubernetes.io/managed-by: {{ .Release.Service }}",
    "{{- end -}}",
    "",
  ].join("\n");
}

function renderValues(_sys: SystemIR, workloads: WorkloadModel[], brokers: BrokerModel[]): string {
  const lines: string[] = [];
  lines.push("# Auto-generated chart values.  Override per environment with");
  lines.push("# `--set key=value` or `-f values.prod.yaml`.");
  lines.push("global:");
  lines.push("  image:");
  lines.push("    # Registry the CI build pushes the per-deployable images to.");
  lines.push("    # Leave empty to use a local image ref (`<name>:<tag>`).");
  lines.push('    registry: ""');
  lines.push("    tag: latest");
  lines.push("    pullPolicy: IfNotPresent");
  lines.push("ingress:");
  lines.push("  # Shared ingress defaults; per-deployable blocks below opt in.");
  lines.push('  className: ""');
  lines.push('  host: ""');
  for (const w of workloads) {
    const light = w.exposesUi && !w.dependsOnDb;
    lines.push(`${w.valuesKey}:`);
    lines.push("  # Whether to render this deployable's workload.  Set false to");
    lines.push("  # install a subset of the system (e.g. one backend at a time).");
    lines.push("  enabled: true");
    lines.push("  replicas: 1");
    lines.push("  resources:");
    lines.push("    requests:");
    lines.push(`      cpu: ${light ? "50m" : "100m"}`);
    lines.push(`      memory: ${light ? "128Mi" : "256Mi"}`);
    lines.push("    limits:");
    lines.push(`      cpu: ${light ? "250m" : "500m"}`);
    lines.push(`      memory: ${light ? "256Mi" : "512Mi"}`);
    lines.push("  # Extra environment overlaid onto the deployable's ConfigMap.");
    lines.push("  env: {}");
    if (w.dbEnv.length > 0) {
      lines.push("  database:");
      lines.push("    # External / managed DB connection string.  The dev-compose");
      lines.push("    # value is a placeholder — point this at your managed DB.");
      // All backends carry exactly one DB-host env var; use its value as the
      // single placeholder url.
      lines.push(`    url: ${JSON.stringify(w.dbEnv[0]!.value)}`);
    }
    if (w.secretEnv.length > 0) {
      lines.push("  secrets:");
      lines.push("    # Sensitive env (passwords / app secret keys).  Dev-compose");
      lines.push("    # values are placeholders — replace for production.");
      for (const e of w.secretEnv) lines.push(`    ${e.name}: ${JSON.stringify(e.value)}`);
    }
    if (w.channelEnv.length > 0) {
      lines.push("  channels:");
      lines.push("    # Broker connection URLs (M-T4.4 §7 — credentials ride the");
      lines.push("    # URL).  Empty = the chart's own enabled broker with its dev");
      lines.push("    # credentials; set to a full URL to use a managed broker");
      lines.push("    # (then disable the matching `brokers.<name>` block).");
      for (const e of w.channelEnv) lines.push(`    ${e.name}: ""`);
    }
    if (w.exposesUi) {
      lines.push("  ingress:");
      lines.push("    enabled: false");
      lines.push('    host: ""');
    }
  }
  for (const b of brokers) {
    if (brokers[0] === b) {
      lines.push("brokers:");
      lines.push("  # In-cluster broker workloads (M-T4.4 slice 5b), auth-provisioned");
      lines.push("  # exactly like the compose sidecars (§7).  Disable one and point");
      lines.push("  # the deployables' `channels:` URLs at a managed broker instead.");
    }
    lines.push(`  ${b.valuesKey}:`);
    lines.push("    enabled: true");
  }
  return lines.join("\n") + "\n";
}

function renderDeploymentTemplate(w: WorkloadModel): string {
  const v = `.Values.${w.valuesKey}`;
  const lines: string[] = [];
  lines.push("apiVersion: apps/v1");
  lines.push("kind: Deployment");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-${w.name}`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${w.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
  lines.push("spec:");
  lines.push(`  replicas: {{ ${v}.replicas }}`);
  lines.push("  selector:");
  lines.push("    matchLabels:");
  lines.push(`      app.kubernetes.io/name: ${w.name}`);
  lines.push("  template:");
  lines.push("    metadata:");
  lines.push("      labels:");
  lines.push(`        app.kubernetes.io/name: ${w.name}`);
  // Prometheus scrape discovery (M-T7.1) — parity with the raw k8s/ manifests.
  if (w.emitsMetrics) {
    lines.push("      annotations:");
    lines.push('        prometheus.io/scrape: "true"');
    lines.push(`        prometheus.io/port: "${w.containerPort}"`);
    lines.push("        prometheus.io/path: /metrics");
  }
  lines.push("    spec:");
  lines.push("      containers:");
  lines.push(`        - name: ${w.name}`);
  lines.push(
    `          image: "{{- with .Values.global.image.registry }}{{ . }}/{{ end }}${w.image}:{{ .Values.global.image.tag }}"`,
  );
  lines.push("          imagePullPolicy: {{ .Values.global.image.pullPolicy }}");
  lines.push("          ports:");
  lines.push(`            - containerPort: ${w.containerPort}`);
  if (w.configEnv.length > 0) {
    lines.push("          envFrom:");
    lines.push("            - configMapRef:");
    lines.push(`                name: ${FULLNAME}-${w.name}-config`);
  }
  const secretRefs = [...w.dbEnv, ...w.secretEnv, ...w.channelEnv];
  if (secretRefs.length > 0) {
    lines.push("          env:");
    for (const e of secretRefs) {
      lines.push(`            - name: ${e.name}`);
      lines.push("              valueFrom:");
      lines.push("                secretKeyRef:");
      lines.push(`                  name: ${FULLNAME}-secrets`);
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
  lines.push(`          resources: {{- toYaml ${v}.resources | nindent 12 }}`);
  return lines.join("\n") + "\n";
}

function renderServiceTemplate(w: WorkloadModel): string {
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: Service");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-${w.name}`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${w.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
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

function renderConfigMapTemplate(w: WorkloadModel): string {
  const v = `.Values.${w.valuesKey}`;
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: ConfigMap");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-${w.name}-config`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${w.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
  lines.push("data:");
  for (const e of w.configEnv) lines.push(`  ${e.name}: ${JSON.stringify(e.value)}`);
  // Per-deployable env overlay from values.
  lines.push(`  {{- range $k, $val := ${v}.env }}`);
  lines.push("  {{ $k }}: {{ $val | quote }}");
  lines.push("  {{- end }}");
  return lines.join("\n") + "\n";
}

function renderIngressTemplate(w: WorkloadModel): string {
  const v = `.Values.${w.valuesKey}`;
  const lines: string[] = [];
  lines.push(`{{- if ${v}.ingress.enabled }}`);
  lines.push("apiVersion: networking.k8s.io/v1");
  lines.push("kind: Ingress");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-${w.name}`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${w.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
  lines.push("spec:");
  lines.push("  {{- with .Values.ingress.className }}");
  lines.push("  ingressClassName: {{ . }}");
  lines.push("  {{- end }}");
  lines.push("  rules:");
  lines.push(`    - host: {{ ${v}.ingress.host | default .Values.ingress.host | quote }}`);
  lines.push("      http:");
  lines.push("        paths:");
  // Same-origin split: the built SPA fetches `/api` relative, so when it
  // targets a distinct backend, front `/api` → that backend and `/` → the SPA
  // on one host (same-origin — no CORS, no separate API host; TLS termination
  // for that host stays the operator's, the chart emits routing only).  `/api`
  // is listed FIRST — the longer prefix must win, and no path rewrite is
  // needed (backends already mount their routes under `/api`).  Fullstack
  // hosts (apiBackend undefined) keep the single `/` catch-all, which already
  // serves their own `/api`.
  if (w.apiBackend) {
    lines.push(`          - path: ${API_BASE_PATH}`);
    lines.push("            pathType: Prefix");
    lines.push("            backend:");
    lines.push("              service:");
    lines.push(`                name: ${FULLNAME}-${w.apiBackend.name}`);
    lines.push("                port:");
    lines.push(`                  number: ${w.apiBackend.servicePort}`);
  }
  lines.push("          - path: /");
  lines.push("            pathType: Prefix");
  lines.push("            backend:");
  lines.push("              service:");
  lines.push(`                name: ${FULLNAME}-${w.name}`);
  lines.push("                port:");
  lines.push(`                  number: ${w.servicePort}`);
  lines.push("{{- end }}");
  return lines.join("\n") + "\n";
}

function renderSecretTemplate(workloads: WorkloadModel[]): string {
  const lines: string[] = [];
  lines.push("apiVersion: v1");
  lines.push("kind: Secret");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-secrets`);
  lines.push("  labels:");
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
  lines.push("type: Opaque");
  lines.push("stringData:");
  for (const w of workloads) {
    for (const e of w.dbEnv) {
      lines.push(`  ${e.secretKey}: {{ .Values.${w.valuesKey}.database.url | quote }}`);
    }
    for (const e of w.secretEnv) {
      lines.push(`  ${e.secretKey}: {{ .Values.${w.valuesKey}.secrets.${e.name} | quote }}`);
    }
    for (const e of w.channelEnv) {
      // Empty values default -> the chart's own broker Service (release-
      // prefixed name) with the dev credentials; a set value wins verbatim.
      lines.push(
        `  ${e.secretKey}: {{ .Values.${w.valuesKey}.channels.${e.name} | default (printf ${JSON.stringify(e.chartFormat)} (include "loom.fullname" .)) | quote }}`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

/** Broker workload template (M-T4.4 slice 5b) — Deployment + Service (+
 *  file ConfigMap), enabled-gated per broker under `.Values.brokers`. */
function renderBrokerTemplate(b: BrokerModel): string {
  const lines: string[] = [];
  lines.push(`{{- if .Values.brokers.${b.valuesKey}.enabled }}`);
  if (b.files.length > 0) {
    lines.push("apiVersion: v1");
    lines.push("kind: ConfigMap");
    lines.push("metadata:");
    lines.push(`  name: ${FULLNAME}-${b.name}-files`);
    lines.push("  labels:");
    lines.push(`    app.kubernetes.io/name: ${b.name}`);
    lines.push('    {{- include "loom.labels" . | nindent 4 }}');
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
  lines.push(`  name: ${FULLNAME}-${b.name}`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${b.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
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
      if (v.includes("%s-")) {
        // The service-name prefix slot resolves to the release fullname.
        lines.push(
          `              value: {{ printf ${JSON.stringify(v.replaceAll("%s-", "%[1]s-"))} (include "loom.fullname" .) | quote }}`,
        );
      } else {
        lines.push(`              value: ${JSON.stringify(v)}`);
      }
    }
  }
  if (b.files.length > 0) {
    lines.push("          volumeMounts:");
    for (const f of b.files) {
      lines.push("            - name: files");
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
    lines.push(`            name: ${FULLNAME}-${b.name}-files`);
  }
  lines.push("---");
  lines.push("apiVersion: v1");
  lines.push("kind: Service");
  lines.push("metadata:");
  lines.push(`  name: ${FULLNAME}-${b.name}`);
  lines.push("  labels:");
  lines.push(`    app.kubernetes.io/name: ${b.name}`);
  lines.push('    {{- include "loom.labels" . | nindent 4 }}');
  lines.push("spec:");
  lines.push("  type: ClusterIP");
  lines.push("  selector:");
  lines.push(`    app.kubernetes.io/name: ${b.name}`);
  lines.push("  ports:");
  lines.push(`    - port: ${b.port}`);
  lines.push(`      targetPort: ${b.port}`);
  lines.push("{{- end }}");
  return lines.join("\n") + "\n";
}

function renderNotes(sys: SystemIR, workloads: WorkloadModel[]): string {
  const uiWorkloads = workloads.filter((w) => w.exposesUi);
  const dbWorkloads = workloads.filter((w) => w.dbEnv.length > 0);
  const lines: string[] = [];
  lines.push(`The ${sys.name} system has been deployed as release {{ .Release.Name }}.`);
  lines.push("");
  lines.push("IMPORTANT — two seams this chart does NOT cover:");
  lines.push("");
  lines.push("  1. Images. Loom emits Dockerfiles, not a registry push. Build and");
  lines.push("     push each deployable's image, then set:");
  lines.push("       --set global.image.registry=<your-registry> --set global.image.tag=<tag>");
  if (dbWorkloads.length > 0) {
    lines.push("");
    lines.push("  2. Database. The chart assumes an EXTERNAL / managed database and");
    lines.push("     ships placeholder connection strings. Supply the real URLs:");
    for (const w of dbWorkloads) lines.push(`       --set ${w.valuesKey}.database.url=<url>`);
  }
  if (uiWorkloads.length > 0) {
    const w = uiWorkloads[0]!;
    lines.push("");
    lines.push("Frontends are ClusterIP by default. Expose one with, e.g.:");
    lines.push(`  --set ${w.valuesKey}.ingress.enabled=true \\`);
    lines.push(`        ${w.valuesKey}.ingress.host=app.example.com`);
    if (w.apiBackend) {
      lines.push("");
      lines.push(
        `That Ingress is same-origin: it routes ${API_BASE_PATH} → the ${w.apiBackend.name}`,
      );
      lines.push("backend and / → the SPA on one host, so the bundle's relative");
      lines.push(`${API_BASE_PATH} fetches resolve without CORS or a separate API host.`);
    }
  }
  lines.push("");
  return lines.join("\n") + "\n";
}

/** Wrap a per-deployable template in an `enabled` guard so a subset of the
 *  system can be installed (e.g. one backend at a time in CI / per-cell e2e).
 *  Defaults to true in values.yaml, so the rendered set is byte-unchanged
 *  unless `--set <key>.enabled=false` is passed.  When disabled the file
 *  renders empty, which Helm/kubeconform treat as no document. */
function gated(w: WorkloadModel, body: string): string {
  return `{{- if .Values.${w.valuesKey}.enabled }}\n${body}{{- end }}\n`;
}

/** A Helm chart under `helm/` for the system.  Reuses the shared
 *  `WorkloadModel` (`buildWorkloads`) so it stays in lock-step with the raw
 *  manifests in `kubernetes.ts`. */
export function renderHelmChart(sys: SystemIR): Map<string, string> {
  const out = new Map<string, string>();
  const workloads = buildWorkloads(sys);
  const brokers = buildBrokers(sys);
  out.set("helm/Chart.yaml", renderChartYaml(sys));
  out.set("helm/values.yaml", renderValues(sys, workloads, brokers));
  out.set("helm/templates/_helpers.tpl", renderHelpers(sys));
  for (const w of workloads) {
    out.set(`helm/templates/${w.name}-deployment.yaml`, gated(w, renderDeploymentTemplate(w)));
    out.set(`helm/templates/${w.name}-service.yaml`, gated(w, renderServiceTemplate(w)));
    if (w.configEnv.length > 0) {
      out.set(`helm/templates/${w.name}-config.yaml`, gated(w, renderConfigMapTemplate(w)));
    }
    if (w.exposesUi) {
      out.set(`helm/templates/${w.name}-ingress.yaml`, gated(w, renderIngressTemplate(w)));
    }
  }
  if (
    workloads.some((w) => w.dbEnv.length > 0 || w.secretEnv.length > 0 || w.channelEnv.length > 0)
  ) {
    out.set("helm/templates/secret.yaml", renderSecretTemplate(workloads));
  }
  for (const b of brokers) {
    out.set(`helm/templates/${b.name}-broker.yaml`, renderBrokerTemplate(b));
  }
  out.set("helm/templates/NOTES.txt", renderNotes(sys, workloads));
  return out;
}
