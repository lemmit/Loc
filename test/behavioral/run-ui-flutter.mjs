// Headless behavioral UI tier — the FLUTTER leg (the SDK-built sibling of
// run-ui.mjs).
//
// Flutter was the ONE frontend with no full-stack runtime round-trip at any
// tier: `generated-flutter-build.yml` is compile-only (`flutter analyze` +
// `flutter build web`), so every defect that survives the Dart type-checker —
// a wrong REST path, a wire shape the model can't decode, a read that never
// fires — shipped invisibly.  This leg closes that: it is run-ui.mjs's exact
// topology (generate → build the frontend → serve the built bundle AND the
// generated Hono backend on PGlite from ONE in-process origin → drive it with
// a real headless Chromium), with two deliberate substitutions.
//
//   1. THE BUILD IS THE FLUTTER SDK, not npm/vite: `flutter pub get` +
//      `flutter build web --release --no-web-resources-cdn`.  The CDN flag is
//      load-bearing, not tidiness — a default `flutter build web` fetches
//      CanvasKit from `gstatic.com` at RUNTIME, so on any network-isolated
//      runner the bundle loads `main.dart.js`, silently fails to boot its
//      renderer, and renders NOTHING with no error at all.  `--no-web-resources-cdn`
//      bundles CanvasKit into `build/web/canvaskit/`, which the one-origin
//      server then serves, and the leg is hermetic.
//
//   2. THE ASSERTIONS READ THE ACCESSIBILITY TREE, not `data-testid`.  Flutter
//      web renders to a CANVAS: there is no DOM for the emitted, testid-driven
//      `*.ui.spec.ts` page objects to select, which is exactly why the flutter
//      emitter ships none (it maps `testid:` onto a widget `Key` for
//      `flutter_test` instead).  What Flutter DOES expose to a browser is its
//      semantics tree — clicking the engine's `flt-semantics-placeholder`
//      ("Enable accessibility") makes it build a real DOM mirror of the
//      rendered widget tree.  So the round-trip is asserted there: seed a row
//      over `/api`, deep-link the app at the route that lists it, and require
//      the app's OWN read to reach the real backend, answer 2xx, decode, and
//      render the seeded value into the accessible text.
//
// What this catches that the compile gates cannot: a read that never fires, a
// REST path the backend 404s, an enum/value-object the Dart model mis-decodes,
// a runtime exception on first paint.  What it shares with them: a Dart source
// that does not compile fails at step 1 (`flutter build web`), so the leg is
// also a superset of the compile gate on the case it runs.
//
// Usage:  npm ci  (in this dir, once) ; node run-ui-flutter.mjs [caseName...]
//         FLUTTER=/path/to/flutter   — SDK override (default: `flutter` on PATH)
// Exit code is non-zero if any case errors or any assertion fails.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { buildServerModule, findDistRoot, findNodeDeployable, walk } from "./ui-stack.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const WORK = join(HERE, ".work-ui-flutter");
const FLUTTER = process.env.FLUTTER ?? "flutter";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

/** The one `platform: flutter` deployable dir: has pubspec.yaml + lib/main.dart. */
function findFlutterDeployable(genDir) {
  const dirs = [
    ...new Set(walk(genDir, (p) => p.endsWith("/pubspec.yaml")).map((p) => dirname(p))),
  ].filter((d) => existsSync(join(d, "lib", "main.dart")));
  if (dirs.length !== 1) {
    throw new Error(
      `expected exactly one flutter deployable (pubspec.yaml + lib/main.dart), found ${dirs.length}: ${dirs.join(", ")}`,
    );
  }
  return dirs[0];
}

/** POST a create over the live origin; returns the created id. */
async function create(origin, coll, body) {
  const res = await fetch(`${origin}/api/${coll}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status >= 300) throw new Error(`seed POST /api/${coll} -> ${res.status}: ${text}`);
  return JSON.parse(text).id;
}

/** Seed the fixture rows the probes read back, straight over the same origin
 *  the browser will use.  Deliberately NOT through the UI: Flutter's semantics
 *  tree exposes text fields only while focused, so a form-driven write is a
 *  flake source; the READ half is where the wire contract actually lives. */
async function seed(origin) {
  const customer = await create(origin, "customers", {
    name: "Zaphod Beeblebrox",
    email: "zaphod@heart.test",
  });
  const product = await create(origin, "products", {
    sku: "FLUTTER-WIDGET",
    price: { amount: 12.5, currency: "USD" },
  });
  const order = await create(origin, "orders", {
    customerId: customer,
    status: "Draft",
    placedAt: "2024-01-01T00:00:00Z",
  });
  const addLine = await fetch(`${origin}/api/orders/${order}/add_line`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId: product, qty: 2 }),
  });
  if (addLine.status >= 300) {
    throw new Error(`seed addLine -> ${addLine.status}: ${await addLine.text()}`);
  }
  const confirm = await fetch(`${origin}/api/orders/${order}/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (confirm.status >= 300) {
    throw new Error(`seed confirm -> ${confirm.status}: ${await confirm.text()}`);
  }
  return { customer, product, order };
}

/** The per-route round-trips.  `expect` is a value the SEEDED row carries, so a
 *  hit proves the whole chain: the app's read fired, the backend answered it,
 *  the Dart model decoded the payload, and the widget rendered it. */
const PROBES = [
  {
    name: "the customers list renders a customer read from the live backend",
    route: "#/customers",
    api: "/api/customers",
    expect: ["Zaphod Beeblebrox", "zaphod@heart.test"],
  },
  {
    // `price` is a value object — its Dart model has its own `fromJson`, so a
    // wire/model divergence shows up here and nowhere in `flutter analyze`.
    name: "the products list renders a value-object-priced product",
    route: "#/products",
    api: "/api/products",
    expect: ["FLUTTER-WIDGET"],
  },
  {
    // `status` is an enum — decoded from the wire string, rendered as a badge.
    name: "the orders list renders the confirmed order's enum status",
    route: "#/orders",
    api: "/api/orders",
    expect: ["Confirmed"],
  },
];

/** Load a hash route, turn the semantics tree on, and return what the app
 *  actually rendered (accessible text) once it settles.
 *
 *  It polls for `expect` rather than for "any text at all": the page CHROME
 *  (app bar, nav buttons) paints on the first frame, long before the async read
 *  resolves, so a "text is non-empty" wait samples the tree too early and the
 *  seeded row is legitimately not there yet. */
async function renderRoute(page, origin, route, expect) {
  await page.goto(`${origin}/${route}`, { waitUntil: "load" });
  // `waitForSelector` is flaky against the placeholder (the engine re-creates
  // it), so poll for it instead, then click it from inside the page — that is
  // what makes Flutter build the DOM mirror of the widget tree.
  await page.waitForFunction(() => !!document.querySelector("flt-semantics-placeholder"), null, {
    timeout: 120_000,
    polling: 250,
  });
  await page.evaluate(() => document.querySelector("flt-semantics-placeholder").click());
  await page.waitForFunction(() => !!document.querySelector("flt-semantics"), null, {
    timeout: 60_000,
    polling: 250,
  });
  const deadline = Date.now() + 30_000;
  let text = "";
  for (;;) {
    // Both halves matter: Flutter puts most rendered strings in the semantics
    // node's TEXT, but a widget that sets its own `Semantics(label:)` (a Chip,
    // for instance — which is how an enum cell renders) carries it as
    // `aria-label` and contributes no innerText at all.
    text = await page.evaluate(
      () =>
        `${document.body.innerText ?? ""}\n${[...document.querySelectorAll("[aria-label]")]
          .map((e) => e.getAttribute("aria-label"))
          .join("\n")}`,
    );
    if (expect.every((e) => text.includes(e))) break;
    if (Date.now() > deadline) break;
    await page.waitForTimeout(250);
  }
  return text;
}

async function runCase(c) {
  const genDir = mkdtempSync(join(tmpdir(), `loom-bhfl-${c.name}-`));
  const workDir = join(WORK, c.name);
  mkdirSync(workDir, { recursive: true });
  let server;
  let browser;
  const results = [];
  try {
    execFileSync(
      "node",
      [join(REPO, "bin/cli.js"), "generate", "system", join(REPO, c.ddd), "-o", genDir],
      { stdio: "pipe" },
    );
    const flutterDir = findFlutterDeployable(genDir);
    const deplDir = findNodeDeployable(genDir);

    // 1. Build the generated Flutter app with the SDK.  This is also the
    //    compile gate: non-parsing / non-type-checking Dart fails right here.
    execFileSync(FLUTTER, ["pub", "get"], { cwd: flutterDir, stdio: "pipe" });
    execFileSync(FLUTTER, ["build", "web", "--release", "--no-web-resources-cdn"], {
      cwd: flutterDir,
      stdio: "pipe",
    });
    const distDir = findDistRoot(flutterDir); // build/web

    // 2. ONE origin: the built Flutter bundle + the generated Hono backend on
    //    PGlite at /api.  No proxy, no CORS — the same invariant run-ui.mjs
    //    relies on, from the same shared module.
    const { startServer } = await buildServerModule(deplDir, workDir);
    server = await startServer({ distDir });
    const origin = `http://127.0.0.1:${server.port}`;
    process.stdout.write(`    stack on :${server.port}\n`);

    await seed(origin);

    // Fetch the browser build THIS playwright expects (run-ui.mjs does the same
    // in the generated e2e dir).  A no-op once cached; without it a harness
    // playwright a minor ahead of whatever is in the browser cache fails at
    // launch with "Executable doesn't exist".
    execFileSync(npx, ["playwright", "install", "--with-deps", "chromium"], {
      cwd: HERE,
      stdio: "pipe",
    });
    browser = await chromium.launch({
      // The full chromium build, not `headless_shell`: CanvasKit needs a real
      // WebGL context, and swiftshader is what provides it on a GPU-less runner.
      channel: "chromium",
      args: ["--no-sandbox", "--enable-unsafe-swiftshader"],
    });
    for (const probe of PROBES) {
      const page = await browser.newPage();
      const api = [];
      const errors = [];
      page.on("response", (r) => {
        const u = new URL(r.url());
        if (u.pathname.startsWith("/api/")) {
          api.push({ method: r.request().method(), path: u.pathname, status: r.status() });
        }
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        // `/favicon.ico` is not emitted by the Flutter target and the browser
        // asks for it unprompted — its 404 is noise, not a finding.
        const t = m.text();
        if (m.type() === "error" && !/favicon/i.test(t) && !/status of 404/.test(t)) {
          errors.push(`console: ${t}`);
        }
      });
      try {
        const text = await renderRoute(page, origin, probe.route, probe.expect);
        const missing = probe.expect.filter((e) => !text.includes(e));
        const read = api.find((r) => r.method === "GET" && r.path === probe.api);
        const bad = api.filter((r) => r.status >= 400);
        const why = [];
        if (!read) why.push(`the app never issued GET ${probe.api} (saw: ${api.map((r) => `${r.method} ${r.path}`).join(", ") || "nothing"})`);
        else if (read.status >= 300) why.push(`GET ${probe.api} -> ${read.status}`);
        if (bad.length) why.push(`api errors: ${bad.map((r) => `${r.method} ${r.path} -> ${r.status}`).join(", ")}`);
        if (missing.length)
          why.push(`not rendered: ${missing.join(", ")} — accessible text was ${JSON.stringify(text.slice(0, 300))}`);
        if (errors.length) why.push(errors.slice(0, 3).join(" | "));
        results.push({ name: probe.name, status: why.length ? "fail" : "pass", error: why.join("; ") });
      } catch (err) {
        results.push({ name: probe.name, status: "fail", error: String(err?.message ?? err) });
      } finally {
        await page.close().catch(() => {});
      }
    }
    return { results };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
    rmSync(genDir, { recursive: true, force: true });
  }
}

const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const corpus = JSON.parse(readFileSync(join(HERE, "corpus.json"), "utf8")).cases.filter(
  (c) => c.uiFlutter === true && (only.length === 0 || only.includes(c.name)),
);
if (corpus.length === 0) {
  process.stdout.write("no flutter UI cases selected\n");
  process.exit(1);
}

let pass = 0;
let fail = 0;
let errored = 0;
for (const c of corpus) {
  process.stdout.write(`\n▶ ${c.name}  (${c.ddd})\n`);
  let out;
  try {
    out = await runCase(c);
  } catch (err) {
    errored++;
    process.stdout.write(`  ERROR: ${err?.message ?? err}\n`);
    continue;
  }
  for (const r of out.results) {
    const ok = r.status === "pass";
    ok ? pass++ : fail++;
    process.stdout.write(`  ${ok ? "✓" : "✗"} [ui-flutter] ${r.name}\n`);
    if (!ok && r.error) process.stdout.write(`      ${r.error}\n`);
  }
}

process.stdout.write(
  `\n${pass} passed, ${fail} failed${errored ? `, ${errored} cases errored` : ""}\n`,
);
process.exit(fail > 0 || errored > 0 ? 1 : 0);
