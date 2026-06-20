import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

// ---------------------------------------------------------------------------
// Kubernetes/Helm validation e2e (docs/kubernetes.md).
//
// For each fixture: `ddd generate system --k8s`, then statically validate the
// emitted deployment artifacts WITHOUT a cluster —
//   1. `helm lint`            — chart well-formedness.
//   2. `helm template` → `kubeconform -strict` — the RENDERED manifests
//      validate against the real Kubernetes API JSON schemas.
//   3. `kubeconform -strict`  — the raw `k8s/` manifests (default-values
//      render) validate too.
//
// This is the cheap, deterministic tier: it catches schema-level breakage
// (bad apiVersion, wrong field types, malformed probes/secretRefs) that the
// unit tests (which only assert substrings) can't.  A real kind-cluster
// smoke (install the chart, wait for rollout, curl /ready) is a heavier
// follow-up tier — see docs/kubernetes.md.
//
// Opt-in via LOOM_K8S=1; requires `helm` + `kubeconform` on PATH (the
// k8s-build.yml workflow installs both).  Skips cleanly when either is
// absent so a local `LOOM_K8S=1` without the tools doesn't hard-fail.
// ---------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const cli = path.join(repoRoot, "bin", "cli.js");

const ENABLED = process.env.LOOM_K8S === "1";

function hasTool(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const TOOLS = ENABLED && hasTool("helm", ["version"]) && hasTool("kubeconform", ["-v"]);

// Representative fixtures spanning the seams the emitter has to get right:
// multi-backend + frontend ingress (hono + react), the Phoenix SECRET_KEY_BASE
// secret, and a Java SPRING_DATASOURCE_PASSWORD secret.
const FIXTURES: string[] = [
  "web/src/examples/inheritance-system.ddd", // hono backend + react frontend (ingress, DB secret)
  "web/src/examples/storefront-elixir.ddd", // phoenix (SECRET_KEY_BASE → Secret)
  "examples/acme.ddd", // multi-deployable showcase
];

describe.skipIf(!TOOLS)("generated Helm chart + k8s manifests validate (LOOM_K8S=1)", () => {
  it.each(FIXTURES)("%s — helm lint + kubeconform", (fixture) => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-k8s-"));
    try {
      execFileSync("node", [cli, "generate", "system", fixture, "-o", outDir, "--k8s"], {
        stdio: "inherit",
        cwd: repoRoot,
      });
      const helmDir = path.join(outDir, "helm");
      const k8sDir = path.join(outDir, "k8s");
      if (!fs.existsSync(path.join(helmDir, "Chart.yaml"))) {
        throw new Error(`${fixture}: no helm/Chart.yaml emitted (does it declare a system?)`);
      }

      // 1. Chart well-formedness.
      execFileSync("helm", ["lint", helmDir], { stdio: "inherit", cwd: repoRoot });

      // 2. Rendered manifests validate against the k8s API schemas.
      const rendered = execFileSync("helm", ["template", "rel", helmDir], {
        cwd: repoRoot,
        maxBuffer: 32 * 1024 * 1024,
      });
      const renderedFile = path.join(outDir, "_rendered.yaml");
      fs.writeFileSync(renderedFile, rendered);
      execFileSync(
        "kubeconform",
        ["-strict", "-summary", "-schema-location", "default", renderedFile],
        { stdio: "inherit", cwd: repoRoot },
      );

      // 3. Raw default-values manifests validate too.
      execFileSync("kubeconform", ["-strict", "-summary", "-schema-location", "default", k8sDir], {
        stdio: "inherit",
        cwd: repoRoot,
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
