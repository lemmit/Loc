// M-FT.13 — the four generation DEFAULTS a hello-world project inherits
// (field-test findings G7, G8, G9, G10).  Each one is a default that made the
// emitted tree heavier, noisier, or unbuildable than it needed to be:
//
//   G7  `docker compose up` started Prometheus + Jaeger for a two-aggregate
//       app, and pointed every backend's OTLP exporter at a collector the
//       lean stack does not run.
//   G7b every web Dockerfile ran `npm ci || npm install`; no generator emits
//       a package-lock.json, so npm dumped its whole EUSAGE usage text into
//       the build log on every first build.
//   G10 the Phoenix `assets-build` stage ran `npm install` BEFORE the
//       `COPY certs/` proxy-CA step, so behind a TLS-terminating proxy the
//       elixir image was the one image in the matrix that could not build.
//   G8  the generated Angular package.json declared no `engines`, so
//       `@angular/cli@22`'s Node floor (^22.22.3) was first heard about as a
//       raw CLI rejection.
//   G9  a MIT LICENSE was injected into the output tree on EVERY `generate`.
//
// The Dockerfile assertions are written as INVARIANTS over every emitted
// Dockerfile rather than per-file string matches, so a new backend or a new
// build stage is covered the day it lands.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderDockerfile as renderDotnetDockerfile } from "../../src/generator/dotnet/emit/program.js";
import { renderDockerfile as renderElixirDockerfile } from "../../src/generator/elixir/shell/project.js";
import { renderDockerfile as renderJavaDockerfile } from "../../src/generator/java/emit/program.js";
import { generateSystemFiles } from "../_helpers/generate.js";

/** Parse + validate + compose, through the shared helper — which asserts
 *  phases ① (syntax), ④ (AST validation) and ⑦ (IR validation) before a
 *  single assertion below runs.  That matters here specifically: `parseHelper`
 *  hands back a PARTIAL ast on a syntax error rather than throwing, so a
 *  fixture with a typo would still compose *something* and every assertion
 *  would be judging output built from a half-read model
 *  (`experience_gathered.md` §59 — the swallowed-parse fixtures).  The
 *  sibling `prometheus-collector.test.ts` fixture was exactly that until this
 *  PR: `ui web { for: OrdersApi }`, which is not a `ui` member at all. */
const filesFor = (src: string): Promise<Map<string, string>> => generateSystemFiles(src);

// A backend + a static React frontend targeting it — the shape a `ddd new`
// project has after `generate system`.  The backend is deliberately named in
// camelCase (`ordersApi`), so its compose SERVICE name is the snake_case slug
// `orders_api`: the overlay has to derive that name the same way the base file
// does, and a fixture named `api` (slug == name) could not tell the two apart.
const SYSTEM = `
system Shop {
  subdomain Sales {
    context Orders {
      aggregate Order with crudish { total: int }
      repository Orders for Order { }
    }
  }
  api OrdersApi from Sales
  storage primary { type: postgres }
  resource st { for: Orders, kind: state, use: primary }
  deployable ordersApi { platform: node contexts: [Orders] serves: OrdersApi dataSources: [st] port: 8080 }
  ui web { api ordersApi: OrdersApi }
  deployable webApp { platform: react ui: web { ordersApi: ordersApi } targets: ordersApi port: 3000 }
}`;

// ---------------------------------------------------------------------------
// G7 — lean compose: the observability bundle is opt-in.
// ---------------------------------------------------------------------------
describe("G7 — the base compose stack is the app, nothing else", () => {
  it("starts no collector and configures no OTLP export by default", async () => {
    const compose = (await filesFor(SYSTEM)).get("docker-compose.yml")!;

    // Neither collector service is in the file a plain `docker compose up`
    // reads.  (Matched as a service key at compose's two-space indent, so the
    // pointer comment naming the overlay does not satisfy the assertion.)
    expect(compose).not.toMatch(/^ {2}prometheus:$/m);
    expect(compose).not.toMatch(/^ {2}jaeger:$/m);

    // And no backend is pointed at a collector that is not running.  The
    // emitted obs/tracing.ts reads an UNSET endpoint as "create spans so
    // trace_id still rides the logs, never export" — so the lean stack is
    // quiet by construction rather than by retry-tolerance.
    expect(compose).not.toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(compose).not.toContain("OTEL_SERVICE_NAME");

    // The app itself is untouched: its services and its database are there.
    expect(compose).toMatch(/^ {2}orders_api:$/m);
    expect(compose).toMatch(/^ {2}web_app:$/m);
    expect(compose).toMatch(/^ {2}db:$/m);

    // The file names the one command that turns observability on, so the
    // overlay is discoverable from the file the user already has open.
    expect(compose).toContain("-f docker-compose.obs.yml");
  });

  it("the overlay carries BOTH halves of the bundle — collectors and export env", async () => {
    const files = await filesFor(SYSTEM);
    const overlay = files.get("docker-compose.obs.yml")!;

    // Collectors.
    expect(overlay).toContain("  prometheus:");
    expect(overlay).toContain("image: prom/prometheus:");
    expect(overlay).toContain("/etc/prometheus/prometheus.yml:ro");
    expect(overlay).toContain('- "9090:9090"');
    expect(overlay).toContain("  jaeger:");
    expect(overlay).toContain('- "16686:16686"');

    // Export env, merged onto the BACKEND service (this is why the bundle is
    // an overlay and not a `profiles:` block: compose can gate a service on a
    // profile, but not a single `environment:` key, so a profile would leave
    // every backend exporting into a void).
    expect(overlay).toMatch(/^ {2}orders_api:$/m);
    expect(overlay).toContain('OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318"');
    expect(overlay).toContain('OTEL_SERVICE_NAME: "orders_api"');

    // The pure static frontend exports nothing — it runs no backend spans.
    expect(overlay).not.toMatch(/^ {2}web_app:$/m);

    // The scrape config the overlay mounts is emitted alongside it.
    expect(files.get("monitoring/prometheus.yml")).toBeDefined();
  });

  // Real `docker compose` is the only thing that can say whether the overlay
  // MERGES the way the design assumes — that the partial `api:` block adds
  // the OTLP keys instead of replacing the base service's whole `environment`
  // map.  Skipped where the binary is absent (it is present in CI's runners
  // and in the dev container); the string assertions above still stand.
  const hasCompose = (() => {
    try {
      return spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasCompose)("the overlay merges onto the base stack, not over it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-compose-merge-"));
    for (const [rel, content] of await filesFor(SYSTEM)) {
      if (!rel.startsWith("docker-compose") && !rel.startsWith("monitoring/")) continue;
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    const config = (...files: string[]) =>
      spawnSync("docker", ["compose", ...files.flatMap((f) => ["-f", f]), "config", "--services"], {
        cwd: dir,
        encoding: "utf8",
      });

    // Base alone is valid compose, and starts nothing but the app.
    const base = config("docker-compose.yml");
    expect(base.status, base.stderr).toBe(0);
    expect(base.stdout.trim().split("\n").sort()).toEqual(["db", "orders_api", "web_app"]);

    // With the overlay the two collectors join in.
    const both = config("docker-compose.yml", "docker-compose.obs.yml");
    expect(both.status, both.stderr).toBe(0);
    expect(both.stdout.trim().split("\n").sort()).toEqual([
      "db",
      "jaeger",
      "orders_api",
      "prometheus",
      "web_app",
    ]);

    // …and the backend's environment is MERGED, not replaced: the base keys
    // survive alongside the OTLP pair.  This is the design's load-bearing
    // assumption — the overlay names `api:` with nothing but an `environment`
    // block, and everything else about that service (build context,
    // depends_on, ports, healthcheck, DATABASE_URL) has to come through from
    // the base file untouched.
    const merged = spawnSync(
      "docker",
      ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.obs.yml", "config"],
      { cwd: dir, encoding: "utf8" },
    );
    expect(merged.status, merged.stderr).toBe(0);
    expect(merged.stdout).toContain("DATABASE_URL: postgres://");
    expect(merged.stdout).toContain("OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318");
    expect(merged.stdout).toContain("OTEL_SERVICE_NAME: orders_api");
  });

  it("emits no overlay at all for a system with no backend to observe", async () => {
    // No backend deployable means no /metrics to scrape and no spans to
    // export, so the observability files are absent rather than emitted
    // empty — and the base compose does not advertise an overlay that is
    // not there.
    const files = await filesFor(`
system Static {
  subdomain S { context C { aggregate A with crudish { n: int } repository As for A { } } }
  api Api from S
}`);
    expect(files.has("docker-compose.obs.yml")).toBe(false);
    expect(files.has("monitoring/prometheus.yml")).toBe(false);
    expect(files.get("docker-compose.yml")!).not.toContain("docker-compose.obs.yml");
  });
});

// ---------------------------------------------------------------------------
// G7b + G10 — every emitted Dockerfile installs quietly, and trusts the
// proxy CAs before it reaches the network.
//
// Collected across every backend x every embedded-SPA shape, so the
// invariants hold for the stages a plain `generate system` never renders.
// ---------------------------------------------------------------------------
function allDockerfiles(): Array<{ name: string; text: string }> {
  return [
    { name: "elixir", text: renderElixirDockerfile("app") },
    {
      name: "elixir+liveview",
      text: renderElixirDockerfile("app", false, "dist", false, "vite", true),
    },
    {
      name: "elixir+spa(vite)",
      text: renderElixirDockerfile("app", true, "dist", false, "vite", false),
    },
    {
      name: "elixir+spa(feliz)",
      text: renderElixirDockerfile("app", true, "dist", false, "feliz", false),
    },
    { name: "dotnet", text: renderDotnetDockerfile("Api") },
    { name: "dotnet+spa(vite)", text: renderDotnetDockerfile("Api", { hasEmbeddedSpa: true }) },
    {
      name: "dotnet+spa(feliz)",
      text: renderDotnetDockerfile("Api", { hasEmbeddedSpa: true, spaBuildKind: "feliz" }),
    },
    { name: "java", text: renderJavaDockerfile({}) },
    { name: "java+spa(vite)", text: renderJavaDockerfile({ embeddedSpa: true }) },
    {
      name: "java+spa(feliz)",
      text: renderJavaDockerfile({ embeddedSpa: true, spaBuildKind: "feliz" }),
    },
    // The standalone FRONTEND hosts are `.hbs` templates rather than TS
    // renderers, and they are the ones finding G7b was actually reported
    // against — so they have to be in the same list, not trusted to a
    // separate eyeball.  Read raw: none of the lines these invariants look at
    // carries a Handlebars expression, so the template text IS the emitted
    // text for the purposes of this check.
    ...(
      [
        ["react/vite host", "docker/dockerfile.hbs"],
        ["sveltekit host", "sveltekit/dockerfile.hbs"],
        ["angular host", "angular/dockerfile.hbs"],
      ] as const
    ).map(([name, rel]) => ({ name, text: fs.readFileSync(rel, "utf8") })),
  ];
}

/** The Dockerfile's INSTRUCTION lines only — comments carry the rationale for
 *  these very rules ("`npm ci` exits with EUSAGE…"), so a whole-text substring
 *  match would flag the explanation as the offence. */
function instructions(text: string): string[] {
  return text.split("\n").filter((l) => l.trim() !== "" && !l.trimStart().startsWith("#"));
}

describe("G7b — no emitted Dockerfile runs `npm ci`", () => {
  it.each(allDockerfiles())("$name", ({ name, text }) => {
    for (const line of instructions(text)) {
      // No generator emits a package-lock.json, so `npm ci` can only ever
      // fail — and even guarded as `npm ci || npm install` it prints npm's
      // full usage dump on every first build.
      expect(line, `${name}: ${line}`).not.toContain("npm ci");
      // A `COPY package-lock.json*` glob is a leftover of the `npm ci` era:
      // it can only ever match nothing, and it advertises a lockfile workflow
      // the generator does not have.
      expect(line, `${name}: ${line}`).not.toContain("package-lock.json");
      // Quiet: no audit report, no funding banner, no extra registry
      // round-trips on a build that just needs the tree.
      if (/\bnpm install\b/.test(line)) {
        expect(line.trim(), name).toBe("RUN npm install --no-audit --no-fund");
      }
    }
  });
});

describe("G10 — every node build stage trusts ./certs before its first install", () => {
  it.each(allDockerfiles())("$name", ({ name, text }) => {
    // Walk the Dockerfile stage by stage.  A stage that installs from the
    // network must have copied the proxy CAs in FIRST — the Phoenix
    // assets-build stage did not, which is why the elixir image was the only
    // one that could not build behind a TLS-terminating proxy.
    const stages: string[][] = [];
    for (const line of text.split("\n")) {
      if (/^FROM /.test(line)) stages.push([]);
      if (stages.length > 0) stages[stages.length - 1].push(line);
    }
    for (const stage of stages) {
      // TLS fetches only.  `apt-get` is deliberately excluded: Debian's
      // repositories are plain HTTP, so the pre-existing `apt-get install`
      // that opens some builder stages is not a TLS handshake and needs no
      // CA.  Everything below negotiates TLS and fails with "unknown_ca"
      // behind a terminating proxy the stage has not been told about.
      const fetchIdx = stage.findIndex((l) =>
        /^RUN .*(npm install|npm ci|curl |dotnet tool restore|mix deps\.get|gradle )/.test(l),
      );
      if (fetchIdx < 0) continue; // a COPY-only runtime stage reaches no network
      const certsIdx = stage.findIndex((l) => /^COPY certs\//.test(l));
      expect(
        certsIdx,
        `${name}: stage "${stage[0]}" reaches the network at "${stage[fetchIdx].trim()}" with no COPY certs/`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        certsIdx,
        `${name}: stage "${stage[0]}" copies certs/ AFTER its first network call`,
      ).toBeLessThan(fetchIdx);
    }
  });
});

// ---------------------------------------------------------------------------
// G8 — the Angular projects declare the Node their own CLI demands.
// ---------------------------------------------------------------------------
describe("G8 — Angular packs pin a Node @angular/cli accepts", () => {
  // `@angular/cli@22` declares engines.node `^22.22.3 || ^24.15.0 || >=26.0.0`
  // and hard-fails below it.  Declaring the same range in the emitted
  // package.json turns that into an `npm install` EBADENGINE warning naming
  // the requirement, instead of a bare version error out of `ng build`.
  const REQUIRED = '"node": "^22.22.3 || ^24.15.0 || >=26.0.0"';
  const packs = ["angularMaterial", "primeng", "spartanNg"];

  it.each(packs)("designs/%s/v1/package-json.hbs declares engines.node", (pack) => {
    const text = fs.readFileSync(`designs/${pack}/v1/package-json.hbs`, "utf8");
    expect(text).toContain('"engines"');
    expect(text.replace(/\s+/g, " ")).toContain(REQUIRED);
  });

  it("the declared range draws its boundaries where the CLI does", () => {
    // Not just "some range is present" — the numbers have to be the CLI's own,
    // clause for clause.  22.22.2 is the version from the field test that
    // `ng build` rejected, so a widened range (`>=22`, say) that accepted it
    // again would be decoration, and this is what catches that.  Asserted on
    // the clause text rather than through a semver library: `semver` is only a
    // transitive dependency here, and a test must not rely on hoisting.
    for (const pack of packs) {
      const text = fs.readFileSync(`designs/${pack}/v1/package-json.hbs`, "utf8");
      const range = /"node":\s*"([^"]+)"/.exec(text)?.[1];
      expect(range, `${pack}: no engines.node range`).toBeDefined();
      expect(
        range!.split("||").map((c) => c.trim()),
        `${pack}: the range must be @angular/cli 22's own clauses`,
      ).toEqual(["^22.22.3", "^24.15.0", ">=26.0.0"]);
    }
  });

  it("no emitted node base image is on a major that cannot satisfy that floor", () => {
    // The emitted Dockerfiles pin a floating MAJOR tag (`node:22-alpine`),
    // whose exact version is not knowable statically — so the honest check is
    // on the major line, not on a literal tag string.
    //
    // A Docker major tag only ever moves FORWARD, so a line whose latest
    // release already clears the floor clears it permanently: 22 is past
    // 22.22.3 (node:22-alpine is v22.23.2 today) and 24 is past 24.15.0
    // (v24.20.0).  Majors 18 and 20 can never satisfy the range at all — no
    // 18.x or 20.x is in it — so pinning one is the real regression here.
    //
    // (An earlier draft of this test asserted `FROM node:24` for every stage,
    // on the belief that `node:22-alpine` satisfied the floor only by luck of
    // the day's patch release.  That was wrong — 22.22.3 is behind the 22
    // line, not ahead of it — and the mistaken assertion pushed a needless
    // Node-24 bump into the java SPA stage, which CI caught.)
    const SATISFIABLE_MAJORS = [22, 24, 26];
    for (const { name, text } of allDockerfiles()) {
      for (const b of text.match(/^FROM node:(\d+)/gm) ?? []) {
        const major = Number(/(\d+)/.exec(b)![1]);
        expect(
          major >= 26 || SATISFIABLE_MAJORS.includes(major),
          `${name}: "${b}" is on a Node major no release of which satisfies ` +
            `@angular/cli 22's ${REQUIRED}`,
        ).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// G9 — `generate` writes build output, not the project's identity files.
// ---------------------------------------------------------------------------
describe("G9 — no LICENSE is injected into a generated tree", () => {
  // These drive the REAL CLI, not `generateSystems`.  The injection this
  // guards never lived in the generator's file map — `runGenerate` set it on
  // the way to disk — so an in-memory assertion would pass whether the bug
  // was present or not.  (Reverting the fix with an in-memory-only check in
  // place did exactly that: 2 passed, mutation undetected.)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cli = path.resolve(here, "..", "..", "bin", "cli.js");

  it("`generate system` writes no LICENSE to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-gen-license-"));
    const src = path.join(dir, "main.ddd");
    fs.writeFileSync(src, SYSTEM);
    const out = path.join(dir, "out");
    const r = spawnSync("node", [cli, "generate", "system", src, "-o", out], {
      encoding: "utf8",
    });
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).not.toContain("Refusing");
    expect(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`).toBe(0);
    // Something was generated (so a silent no-op cannot pass this test)…
    expect(fs.existsSync(path.join(out, "docker-compose.yml"))).toBe(true);
    // …and the user's tree did not acquire a licence it did not ask for.
    expect(fs.existsSync(path.join(out, "LICENSE"))).toBe(false);
  });

  it("`ddd new` still scaffolds the MIT grant over the output", () => {
    // The licence did not disappear — it moved to the command that OWNS the
    // project's identity files (main.ddd / README.md / .loomignore), where it
    // is written once instead of being re-created after every delete.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-new-license-"));
    const proj = path.join(dir, "shop");
    const r = spawnSync("node", [cli, "new", "shop", "--out", proj], { encoding: "utf8" });
    expect(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`).toBe(0);
    const licence = fs.readFileSync(path.join(proj, "LICENSE"), "utf8");
    expect(licence).toContain("MIT License");
    expect(licence).toContain("docs/license-faq.md");
  });
});
